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

// Parents before children, so every FK target exists first (header).
export const RESTORE_ORDER = [
  // Foundations
  'categories', 'vendors', 'items', 'recipes', 'recipe_ingredients', 'recipe_suggestions',
  // Crest Customization (S758): groups before options before their ingredients (composite FKs);
  // the attachment needs recipes and groups AND pos_options (default_option_id). Items and recipes
  // are above, which pos_option_ingredients' item_id / sub_recipe_id point at.
  'pos_option_groups', 'pos_options', 'pos_option_ingredients', 'pos_recipe_option_groups',
  'monthly_periods', 'monthly_owner_reports',
  // Fixed assets
  'assets_categories', 'assets_register', 'assets_repair_expenses',
  // D40: before the runs, so its lock trigger (a posted run for its year or later) never sees one.
  'assets_tax_pool_openings',
  'assets_tax_pool_runs', 'assets_tax_pool_lines',
  'assets_depreciation_runs', 'assets_depreciation_schedule',
  // IMS operational
  'overheads', 'par_levels', 'purchase_orders', 'purchase_order_items',
  'requisitions', 'requisition_lines', 'ims_gate_passes',
  'demand_forecast_run_log', 'demand_forecast_daily',
  'purchase_entries', 'payable_payments', 'vendor_returns',
  'opening_stock', 'closing_stock', 'wastages', 'staff_meals', 'budgets',
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
  'pos_tables', 'pos_loyalty_schemes', 'pos_customers', 'pos_shifts',
  // pos_order_item_options (S758) right after the lines it snapshots — FKs to the order and the line.
  'pos_orders', 'pos_order_items', 'pos_order_item_options', 'pos_order_payments', 'pos_kot_log', 'pos_kot_removals',
  // A slip names the bill it was stamped against (order_id), so after the orders (S809 DATABASE-3).
  // pos_parking_slips_guard keeps a restored slip's number, issuer and times as they were.
  'pos_parking_slips',
  'pos_loyalty_ledger',
  // Reservations reference pos_orders (order_id) and pos_tables (via the join table), both above.
  'pos_reservations', 'pos_reservation_tables',
  'pos_credit_notes',
  // After the shifts, the orders AND the credit notes (S809 DATABASE-3): a refund names its note.
  // A restored note's own trigger (pos_credit_note_settle, S809 2e) links its bill and writes no
  // refund, so the refund the backup carries is restored here exactly once.
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
const GENERATED_COLUMNS = {
  items: ['per_uom_rate'],
  pos_customers: ['phone_canonical'],
  pos_reservations: ['phone_canonical'],
}

// pos_orders.credit_note_id -> pos_credit_notes.id, while pos_credit_notes.order_id ->
// pos_orders.id. Neither cascades, so one of the two must be inserted with the link empty and
// patched afterwards. Same shape as the null-first step deleteClientData does in reverse.
// hr_employees.supervisor_id -> hr_employees.id (S798 DATABASE-4) is the self-referencing case: a
// supervisor in a later 500-row chunk than their team would fail the FK, so it goes in afterwards too.
export const DEFERRED_LINKS = { pos_orders: ['credit_note_id'], hr_employees: ['supervisor_id'] }

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
