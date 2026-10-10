import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  derivePinPassword, isPasswordPwned, getAppSecrets, encryptPin, decryptPin, resetAppSecretsCache,
} from '../_shared/pinPassword.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Revokes every live tablet key a client holds and switches its legacy shared key off (S755).
 *
 * Archive, Clear Client Data, Delete Client and the trial purge all run deleteClientDataFor, and
 * none of them touched `pos_devices` (migration 20260916120000): an archived outlet's tablets kept
 * keys that pos-staff-login still accepted, and Archive keeps every staff login, so a tablet on the
 * counter of a client who had left could still sign a waiter in. Delete Client cascades the rows
 * away eventually; Archive and Clear never did.
 *
 * The same two writes as `revoke_pos_device` and `retire_pos_legacy_device_key` (dropped in S809 3h,
 * with nothing left that reads the shared key), done here with the
 * service role because both functions refuse a caller with no session (`pos_device_caller_may_manage`
 * keys on auth.uid(), which is NULL under the service role). The legacy key is ROTATED, not just
 * stamped, exactly as the SQL function does, so every comparison against the old value — a tablet
 * on a pre-S754 bundle included — stops matching. Both are idempotent: an already-revoked tablet
 * and an already-retired key are left alone, so a retried Archive changes nothing twice.
 *
 * A restore brings the data back but NOT the keys (pos_devices is never exported), so a restored
 * client re-activates each tablet from POS Setup — the confirm copy in ClientDrawer says so.
 *
 * Audit rows mirror `pos_devices_audit` (never the hash) and the retire function's timestamp-only
 * row; `client_secrets` is deliberately unaudited because its snapshot would carry both secrets.
 * An audit insert that fails is logged, not thrown — the revocation it describes has already landed.
 */
async function revokeClientTablets(admin: ReturnType<typeof createClient>, clientId: string, actorId: string | null) {
  const now = new Date().toISOString()

  const { data: revoked, error: devErr } = await admin
    .from('pos_devices')
    .update({ revoked_at: now, revoked_by: actorId })
    .eq('client_id', clientId)
    .is('revoked_at', null)
    .select('id, client_id, name, created_by, created_at, last_used_at, revoked_at, revoked_by')
  if (devErr) throw new Error(`Failed to revoke this client's POS tablet keys: ${devErr.message}`)
  // S809 3h (owner decision Q18 a): revoking a tablet ends the sessions opened on it. A till lock now
  // ends only its own tablet's session, so the till logins still signed in are ended here, as the
  // counting tablets' are below (pos_revoke_till_sessions, migration 20261010180000, service role only).
  const { error: posSessErr } = await admin.rpc('pos_revoke_till_sessions', { p_client_id: clientId })
  if (posSessErr) throw new Error(`Failed to sign out this client's POS tills: ${posSessErr.message}`)

  const { data: retired, error: keyErr } = await admin
    .from('client_secrets')
    .update({ pos_device_secret: crypto.randomUUID(), pos_legacy_key_retired_at: now, updated_at: now })
    .eq('client_id', clientId)
    .is('pos_legacy_key_retired_at', null)
    .select('client_id, pos_legacy_key_retired_at')
  if (keyErr) throw new Error(`Failed to switch off this client's shared POS key: ${keyErr.message}`)

  // The stock-count tablets hold a key of their own (S737), which this function used to leave
  // alone — an archived or wiped client's store-room tablet still read the roster and signed
  // counters in (S756). Rotating it is the whole revoke: every enrolled tablet's copy stops
  // matching, and the enrol token goes with it so an open QR cannot re-issue the new one.
  const { data: imsRotated, error: imsKeyErr } = await admin
    .from('client_secrets')
    .update({ ims_device_secret: crypto.randomUUID(), ims_enrol_token: null, ims_enrol_token_expires_at: null, updated_at: now })
    .eq('client_id', clientId)
    .select('client_id')
  if (imsKeyErr) throw new Error(`Failed to sign out this client's stock-count tablets: ${imsKeyErr.message}`)
  // S792 (MASTER-3): the key change stops the NEXT sign-in only. A tablet already signed in held an
  // ordinary session that nothing re-checked, so its counting login's sessions are ended too
  // (ims_revoke_count_sessions, migration 20260928140000, service role only).
  const { error: imsSessErr } = await admin.rpc('ims_revoke_count_sessions', { p_client_id: clientId })
  if (imsSessErr) throw new Error(`Failed to end this client's stock-count tablet sessions: ${imsSessErr.message}`)
  const imsTabletsSignedOut = (imsRotated || []).length > 0

  const devices = (revoked || []) as Array<Record<string, unknown>>
  const legacyRetired = (retired || []).length > 0
  if (devices.length > 0 || legacyRetired || imsTabletsSignedOut) {
    const { data: cl } = await admin.from('clients').select('name').eq('id', clientId).maybeSingle()
    let userName: string | null = null
    if (actorId) {
      const { data: pr } = await admin.from('profiles').select('full_name').eq('id', actorId).maybeSingle()
      userName = pr?.full_name ?? null
    }
    const base = { client_id: clientId, client_name: cl?.name ?? null, user_id: actorId, user_name: userName }
    const rows = [
      ...devices.map((d) => ({
        ...base, table_name: 'pos_devices', action: 'UPDATE', record_id: d.id,
        old_data: { ...d, revoked_at: null, revoked_by: null },
        new_data: d,
      })),
      ...(legacyRetired ? [{
        ...base, table_name: 'client_secrets', action: 'UPDATE', record_id: clientId,
        old_data: { pos_legacy_key_retired_at: null },
        new_data: { pos_legacy_key_retired_at: now },
      }] : []),
      // Never the key itself: client_secrets is unaudited precisely so a secret cannot reach
      // audit_logs in plaintext.
      ...(imsTabletsSignedOut ? [{
        ...base, table_name: 'client_secrets', action: 'UPDATE', record_id: clientId,
        old_data: null,
        new_data: { ims_count_tablets_signed_out_at: now },
      }] : []),
    ]
    const { error: auditErr } = await admin.from('audit_logs').insert(rows)
    if (auditErr) console.error('[admin-user-ops] tablet revocation audit insert failed:', auditErr.message)
  }

  return { tablets_revoked: devices.length, legacy_key_retired: legacyRetired, ims_tablets_signed_out: imsTabletsSignedOut }
}

// How long a settled leaver's login is banned for when a restore puts the block back (S798). Final
// Settlement writes banned_until = 2999 in SQL; GoTrue's admin API takes a duration, and a hundred
// years is the same answer. reopen_final_settlement clears whichever it finds.
const LEAVER_BAN = '876000h'

// Which module an Inventory row belongs to, by its source (S809 DATABASE-2). Clear POS Transactions
// used to delete every stock_movements row of the client, the manual Sales Entry depletion included,
// and Clear IMS Transactions every POS one, and since S809 2e a "not served" credit note's
// 'pos_credit_restock' rows were in neither clear's list. Every value sales_entries_source_check and
// stock_movements_source_check allow (migration 20261010100000) is in exactly one list below; a
// sales_entries row with no source is a hand-entered sale (the column's legacy default) and is IMS's.
// clearModuleSources.test.js holds these four lists to both CHECKs.
const IMS_SALES_SOURCES = ['manual']
const POS_SALES_SOURCES = ['pos', 'pos_comp', 'pos_credit', 'pos_credit_restock']
const IMS_MOVEMENT_SOURCES = ['manual']
const POS_MOVEMENT_SOURCES = ['pos_sale', 'pos_comp', 'pos_credit_restock']

// What each column that keeps a till login's name means, for the sentence that refuses a Delete
// (S809 ACCESS-5). Which columns count is the database's: pos_login_reference_columns() reads every
// foreign key to a login that does not go with it, plus pos_orders.opened_by and
// pos_order_items.comped_by, so a new one is counted the day its key exists. This map only words
// them; one it does not know reads as "other records". posLoginRecords.test.js holds it to the POS
// keys in the migrations.
const POS_RECORD_WORDS: Record<string, [string, string]> = {
  'pos_orders.closed_by':               ['closed 1 bill', 'closed {n} bills'],
  'pos_orders.opened_by':               ['opened 1 order', 'opened {n} orders'],
  'pos_orders.credit_settled_by':       ['settled 1 credit bill', 'settled {n} credit bills'],
  'pos_order_items.comped_by':          ['made 1 dish complimentary', 'made {n} dishes complimentary'],
  'pos_order_payments.recorded_by':     ['recorded 1 payment', 'recorded {n} payments'],
  'pos_shifts.opened_by':               ['opened 1 shift', 'opened {n} shifts'],
  'pos_shifts.closed_by':               ['closed 1 shift', 'closed {n} shifts'],
  'pos_cash_movements.created_by':      ['recorded 1 cash entry', 'recorded {n} cash entries'],
  'pos_credit_notes.issued_by':         ['issued 1 credit note', 'issued {n} credit notes'],
  'pos_kot_log.sent_by':                ['sent 1 kitchen ticket', 'sent {n} kitchen tickets'],
  'pos_kot_log.status_updated_by':      ['moved 1 kitchen ticket along', 'moved {n} kitchen tickets along'],
  'pos_kot_removals.removed_by':        ['took 1 sent dish off a bill', 'took {n} sent dishes off bills'],
  'pos_parking_slips.issued_by':        ['issued 1 parking slip', 'issued {n} parking slips'],
  'pos_parking_slips.exited_by':        ['marked 1 vehicle as gone', 'marked {n} vehicles as gone'],
  'pos_reservations.created_by':        ['took 1 booking', 'took {n} bookings'],
  'pos_loyalty_ledger.created_by':      ['recorded 1 points entry', 'recorded {n} points entries'],
  'pos_guest_order_requests.decided_by': ['answered 1 guest QR order', 'answered {n} guest QR orders'],
  'pos_devices.created_by':             ['activated 1 till', 'activated {n} tills'],
  'pos_devices.revoked_by':             ['switched off 1 till', 'switched off {n} tills'],
  'profiles.pos_blocked_by':            ['blocked 1 login', 'blocked {n} logins'],
}

// "closed 14 bills, opened 3 shifts and sent 120 kitchen tickets" from pos_login_recorded_rows' rows,
// in POS_RECORD_WORDS' order, at most four named and the rest summed as other records.
function describePosLoginRecords(rows: Array<{ table_name: string; column_name: string; n: number | string }>): string {
  const order = Object.keys(POS_RECORD_WORDS)
  const named: Array<{ at: number; n: number; words: [string, string] }> = []
  let other = 0
  for (const r of rows) {
    const n = Number(r.n) || 0
    if (n <= 0) continue
    const key = `${r.table_name}.${r.column_name}`
    const words = POS_RECORD_WORDS[key]
    if (words) named.push({ at: order.indexOf(key), n, words })
    else other += n
  }
  named.sort((a, b) => a.at - b.at)
  for (const x of named.slice(4)) other += x.n
  const parts = named.slice(0, 4).map(x => (x.n === 1 ? x.words[0] : x.words[1]).replace('{n}', x.n.toLocaleString('en-IN')))
  if (other > 0) parts.push(other === 1 ? 'recorded 1 other entry' : `recorded ${other.toLocaleString('en-IN')} other entries`)
  if (parts.length <= 1) return parts[0] || 'recorded entries'
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

// S792 (DATABASE-5). An id list travels in the URL, and the gateway refuses one past a few hundred
// uuids (414, measured at ~254 in S706). The wipes below used to pass a client's whole list at once
// — every recipe, order or bill line — so on a mature client they threw part-way, after
// recipe_ingredients was already gone: Archive left an active client whose dishes had no
// ingredients, restore refused a non-empty client, and every retry failed identically. Ids are now
// read in full (a bare select stops at 1000 rows, and dropped its read error) and deleted 100 at a
// time; a child table that carries client_id is deleted by that instead, with no list at all.
const ID_CHUNK = 100

type IdPage = PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }>

async function readAllIds(label: string, page: (from: number, to: number) => IdPage): Promise<string[]> {
  const ids: string[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999)
    if (error) throw new Error(`Failed to read ${label}: ${error.message ?? String(error)}`)
    const rows = (data || []) as Array<{ id: string }>
    ids.push(...rows.map(r => r.id))
    if (rows.length < 1000) return ids
  }
}

async function deleteByIdChunks(admin: ReturnType<typeof createClient>, table: string, column: string, ids: string[], label: string) {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { error } = await admin.from(table).delete().in(column, ids.slice(i, i + ID_CHUNK))
    if (error) throw new Error(`Failed to delete ${label}: ${(error as { message?: string }).message ?? String(error)}`)
  }
}

/**
 * Deletes every business row belonging to one client, in FK-safe order.
 *
 * Extracted from the `deleteClientData` action (S672) so the automatic trial purge can reuse the
 * exact same sequence rather than carrying a second copy. That mattered more here than anywhere
 * else in this function: this is the most destructive code in the product, it is ~130 lines of
 * hand-ordered deletes, and a second copy would drift the first time a table was added to one and
 * not the other -- silently, because the symptom is a row that quietly survives a wipe.
 *
 * Throws on the first failure, by design: a half-deleted client must be visible, not reported as a
 * success. Callers translate the throw into their own error shape.
 *
 * @param keepStaffVault Archive passes true -- it keeps every auth login, and the vault rows key on
 *   those user ids, so deleting them would irreversibly lose every staff PIN on a path the product
 *   calls fully reversible (S574).
 */
async function deleteClientDataFor(admin: ReturnType<typeof createClient>, clientId: string, keepStaffVault = false, actorId: string | null = null) {
  const keep_staff_vault = keepStaffVault

  // S755: tablets first. If a delete below throws, the client is half-cleared and the operator
  // retries — but no tablet of a client being archived or wiped stays able to sign a waiter in
  // meanwhile. Idempotent, so the retry is safe.
  const tablets = await revokeClientTablets(admin, clientId, actorId)
  // keep_staff_vault: passed by Archive. Archive keeps every auth login, and the vault rows
  // key on those user ids — deleting them made the product's "fully reversible" path
  // irreversibly lose every staff PIN: the restore's vault-rebuild branch only runs when the
  // client has NO logins left, which is exactly the state Archive never produces (S574).

  async function del(query: Promise<{ error: unknown }>, label: string) {
    const { error } = await query
    if (error) throw new Error(`Failed to delete ${label}: ${(error as { message?: string }).message ?? String(error)}`)
  }

  // A month's worth of ids per year of trading: this list stays short enough for one URL.
  const periodIds = await readAllIds('monthly_periods', (f, t) =>
    admin.from('monthly_periods').select('id').eq('client_id', clientId).order('id').range(f, t))
  const recipeIds = await readAllIds('recipes', (f, t) =>
    admin.from('recipes').select('id').eq('client_id', clientId).order('id').range(f, t))
  const poIds = await readAllIds('purchase_orders', (f, t) =>
    admin.from('purchase_orders').select('id').eq('client_id', clientId).order('id').range(f, t))
  const reqIds = await readAllIds('requisitions', (f, t) =>
    admin.from('requisitions').select('id').eq('client_id', clientId).order('id').range(f, t))

  await deleteByIdChunks(admin, 'recipe_ingredients', 'recipe_id', recipeIds, 'recipe_ingredients')
  // recipe_suggestions carries client_id, and both of its recipe columns point at this client's own
  // recipes, so one delete by client covers both directions.
  await del(admin.from('recipe_suggestions').delete().eq('client_id', clientId), 'recipe_suggestions')
  await deleteByIdChunks(admin, 'purchase_order_items', 'po_id', poIds, 'purchase_order_items')
  await deleteByIdChunks(admin, 'requisition_lines', 'requisition_id', reqIds, 'requisition_lines')

  // By client_id, not by a list of every bill line's id — that list was the likeliest 414 of all.
  await del(admin.from('payable_payments').delete().eq('client_id', clientId), 'payable_payments')
  if (periodIds.length > 0) {
    await del(admin.from('purchase_entries').delete().in('period_id', periodIds), 'purchase_entries')
    await del(admin.from('vendor_returns').delete().in('period_id', periodIds), 'vendor_returns')
    await del(admin.from('opening_stock').delete().in('period_id', periodIds), 'opening_stock')
    await del(admin.from('closing_stock').delete().in('period_id', periodIds), 'closing_stock')
    await del(admin.from('wastages').delete().in('period_id', periodIds), 'wastages')
    await del(admin.from('staff_meals').delete().in('period_id', periodIds), 'staff_meals')
    await del(admin.from('sales_entries').delete().in('period_id', periodIds), 'sales_entries')
    await del(admin.from('budgets').delete().in('period_id', periodIds), 'budgets')
  }

  // POS module data (orders reference tables; movements/orders must go before periods)
  // Circular FK: pos_orders.credit_note_id -> pos_credit_notes.id AND
  // pos_credit_notes.order_id -> pos_orders.id, neither ON DELETE CASCADE.
  // Null the order-side link first or deleting pos_credit_notes fails.
  await del(admin.from('pos_orders').update({ credit_note_id: null }).eq('client_id', clientId), 'pos_orders.credit_note_id reset')
  await del(admin.from('pos_credit_notes').delete().eq('client_id', clientId), 'pos_credit_notes')
  await del(admin.from('pos_payment_confirmations').delete().eq('client_id', clientId), 'pos_payment_confirmations')
  await del(admin.from('pos_guest_order_requests').delete().eq('client_id', clientId), 'pos_guest_order_requests')
  // By client_id (S792, DATABASE-5): every order id of a busy till was thousands of uuids in one URL.
  await del(admin.from('pos_order_items').delete().eq('client_id', clientId), 'pos_order_items')
  await del(admin.from('stock_movements').delete().eq('client_id', clientId), 'stock_movements')
  // Before orders/shifts — its FKs to both are ON DELETE SET NULL.
  await del(admin.from('pos_cash_movements').delete().eq('client_id', clientId), 'pos_cash_movements')
  await del(admin.from('pos_loyalty_ledger').delete().eq('client_id', clientId), 'pos_loyalty_ledger')
  // Reservations: order_id SET NULLs and the join table cascades, so neither is load-bearing —
  // named so the sequence still lists every table it clears (the S382 lesson).
  await del(admin.from('pos_reservation_tables').delete().eq('client_id', clientId), 'pos_reservation_tables')
  await del(admin.from('pos_reservations').delete().eq('client_id', clientId), 'pos_reservations')
  await del(admin.from('pos_kot_removals').delete().eq('client_id', clientId), 'pos_kot_removals')
  await del(admin.from('pos_orders').delete().eq('client_id', clientId), 'pos_orders')
  await del(admin.from('pos_shifts').delete().eq('client_id', clientId), 'pos_shifts')
  await del(admin.from('pos_customers').delete().eq('client_id', clientId), 'pos_customers')
  await del(admin.from('pos_loyalty_schemes').delete().eq('client_id', clientId), 'pos_loyalty_schemes')
  await del(admin.from('pos_parking_slips').delete().eq('client_id', clientId), 'pos_parking_slips')
  await del(admin.from('pos_tables').delete().eq('client_id', clientId), 'pos_tables')

  // HR module data (payslips reference runs; attendance/payroll reference monthly_periods)
  const { data: runRows } = await admin.from('hr_payroll_runs').select('id').eq('client_id', clientId)
  const runIds = (runRows || []).map((r: { id: string }) => r.id)
  if (runIds.length > 0) {
    await del(admin.from('hr_payslips').delete().in('run_id', runIds), 'hr_payslips')
  }
  // Repayments BEFORE the runs (S752): payroll_run_id is ON DELETE NO ACTION, so deleting a run a
  // payroll recovery points at threw here, after the payslips were already gone. Salary payments
  // (S782) the same: run_id and employee_id are both NO ACTION.
  await del(admin.from('hr_salary_payments').delete().eq('client_id', clientId), 'hr_salary_payments')
  await del(admin.from('hr_advance_repayments').delete().eq('client_id', clientId), 'hr_advance_repayments')
  await del(admin.from('hr_payroll_runs').delete().eq('client_id', clientId), 'hr_payroll_runs')
  // Before hr_advance_repayments (whose final_settlement_id points at it) and before
  // hr_employees, so neither is left referencing a row that no longer exists.
  await del(admin.from('hr_final_settlements').delete().eq('client_id', clientId), 'hr_final_settlements')
  await del(admin.from('hr_attendance').delete().eq('client_id', clientId), 'hr_attendance')
  await del(admin.from('hr_leave_requests').delete().eq('client_id', clientId), 'hr_leave_requests')
  await del(admin.from('hr_overtime_entries').delete().eq('client_id', clientId), 'hr_overtime_entries')
  await del(admin.from('hr_festival_allowances').delete().eq('client_id', clientId), 'hr_festival_allowances')
  await del(admin.from('hr_advance_repayments').delete().eq('client_id', clientId), 'hr_advance_repayments')
  await del(admin.from('hr_advances').delete().eq('client_id', clientId), 'hr_advances')
  await del(admin.from('hr_roster').delete().eq('client_id', clientId), 'hr_roster')
  // hr_tada_claim_items cascades from hr_tada_claims; hr_incentives.config_id SET NULLs on config delete
  await del(admin.from('hr_tada_claims').delete().eq('client_id', clientId), 'hr_tada_claims')
  await del(admin.from('hr_incentives').delete().eq('client_id', clientId), 'hr_incentives')
  await del(admin.from('hr_incentive_configs').delete().eq('client_id', clientId), 'hr_incentive_configs')
  await del(admin.from('hr_roster_publish_state').delete().eq('client_id', clientId), 'hr_roster_publish_state')
  await del(admin.from('hr_shift_swap_requests').delete().eq('client_id', clientId), 'hr_shift_swap_requests')
  await del(admin.from('hr_salary_components').delete().eq('client_id', clientId), 'hr_salary_components')
  await del(admin.from('hr_employees').delete().eq('client_id', clientId), 'hr_employees')
  await del(admin.from('hr_leave_types').delete().eq('client_id', clientId), 'hr_leave_types')
  await del(admin.from('hr_holiday_calendar').delete().eq('client_id', clientId), 'hr_holiday_calendar')
  await del(admin.from('hr_shift_types').delete().eq('client_id', clientId), 'hr_shift_types')

  await del(admin.from('purchase_orders').delete().eq('client_id', clientId), 'purchase_orders')
  await del(admin.from('requisitions').delete().eq('client_id', clientId), 'requisitions')
  await del(admin.from('overheads').delete().eq('client_id', clientId), 'overheads')
  await del(admin.from('par_levels').delete().eq('client_id', clientId), 'par_levels')
  await del(admin.from('demand_forecast_daily').delete().eq('client_id', clientId), 'demand_forecast_daily')
  await del(admin.from('demand_forecast_run_log').delete().eq('client_id', clientId), 'demand_forecast_run_log')
  // No FK cascade from monthly_owner_reports.period_id -> monthly_periods.id — must go first.
  await del(admin.from('monthly_owner_reports').delete().eq('client_id', clientId), 'monthly_owner_reports')
  await del(admin.from('monthly_periods').delete().eq('client_id', clientId), 'monthly_periods')
  // Crest Customization (S758) BEFORE recipes and items: pos_option_ingredients' item_id and
  // sub_recipe_id are plain FKs, so a client with any option ingredient would refuse both deletes
  // below. Children first — the composite FKs cascade anyway, but the sequence names every table.
  await del(admin.from('pos_recipe_option_groups').delete().eq('client_id', clientId), 'pos_recipe_option_groups')
  await del(admin.from('pos_option_ingredients').delete().eq('client_id', clientId), 'pos_option_ingredients')
  await del(admin.from('pos_options').delete().eq('client_id', clientId), 'pos_options')
  await del(admin.from('pos_option_groups').delete().eq('client_id', clientId), 'pos_option_groups')
  await del(admin.from('recipes').delete().eq('client_id', clientId), 'recipes')
  await del(admin.from('items').delete().eq('client_id', clientId), 'items')
  await del(admin.from('ims_gate_passes').delete().eq('client_id', clientId), 'ims_gate_passes')
  await del(admin.from('assets_depreciation_schedule').delete().eq('client_id', clientId), 'assets_depreciation_schedule')
  await del(admin.from('assets_depreciation_runs').delete().eq('client_id', clientId), 'assets_depreciation_runs')
  await del(admin.from('assets_tax_pool_lines').delete().eq('client_id', clientId), 'assets_tax_pool_lines')
  await del(admin.from('assets_tax_pool_runs').delete().eq('client_id', clientId), 'assets_tax_pool_runs')
  await del(admin.from('assets_tax_pool_openings').delete().eq('client_id', clientId), 'assets_tax_pool_openings')
  await del(admin.from('assets_repair_expenses').delete().eq('client_id', clientId), 'assets_repair_expenses')
  await del(admin.from('assets_register').delete().eq('client_id', clientId), 'assets_register')
  await del(admin.from('assets_categories').delete().eq('client_id', clientId), 'assets_categories')
  await del(admin.from('vendors').delete().eq('client_id', clientId), 'vendors')
  // Before categories: category_id cascades, so this is belt-and-braces rather than required,
  // but CLAUDE.md step 7 asks for every client-scoped table to be listed explicitly (S737).
  await del(admin.from('ims_count_assignments').delete().eq('client_id', clientId), 'ims_count_assignments')
  await del(admin.from('categories').delete().eq('client_id', clientId), 'categories')
  // Onboarding checklist state (S790). Nothing references it and both its FKs cascade, but Clear
  // Client Data and Archive keep the clients row and every login, so without this a wiped client's
  // checklist would still say its setup steps were done.
  await del(admin.from('onboarding_progress').delete().eq('client_id', clientId), 'onboarding_progress')
  // Cascades from both profiles and clients, so this is belt-and-braces rather than required —
  // but CLAUDE.md step 7 asks for every client-scoped table to be listed explicitly, and a
  // table that only ever cleans itself up implicitly is the kind that gets missed when the
  // cascade is later changed. app_secrets is deliberately absent: it is app-wide, not
  // per-client, and must never be touched by a client clear/delete path.
  if (!keep_staff_vault) {
    await del(admin.from('staff_pin_vault').delete().eq('client_id', clientId), 'staff_pin_vault')
  }

  return tablets
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  try {
    const url  = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const svc  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Service-role client used for all privileged writes. Re-created once the caller is known (below)
    // so every PostgREST write carries x-crest-actor — log_audit() reads it to name who acted, since
    // auth.uid() is NULL under the service role (S753). `let` so the helpers closing over it follow.
    let admin = createClient(url, svc, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const body = await req.json()
    const { action, ...params } = body

    // ── PIN vault write (20260812110000) ──────────────────────────────────────
    // Deliberately best-effort: a vault failure must NEVER fail the operation that called it.
    // The account is already valid without a vault row -- the PIN works, login works, only
    // admin recovery is unavailable -- and the next reset, or the login functions' lazy-upgrade
    // branch, repopulates it. Failing the create/reset here would trade a recovery convenience
    // for an outage on the restaurant floor, which is the wrong way round.
    const vaultPin = async (userId: string, clientId: string, kind: 'pos' | 'hr_self_service' | 'ims_count', pin: string) => {
      try {
        const { vaultKey } = await getAppSecrets(admin)
        if (!vaultKey) {
          console.error('[admin-user-ops] no vault key available — PIN not recoverable for', userId)
          return
        }
        const { error } = await admin.from('staff_pin_vault').upsert({
          user_id:    userId,
          client_id:  clientId,
          kind,
          pin_cipher: await encryptPin(pin, vaultKey),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })
        if (error) console.error('[admin-user-ops] staff_pin_vault write failed:', error.message)
      } catch (e) {
        console.error('[admin-user-ops] staff_pin_vault encrypt failed:', e instanceof Error ? e.message : e)
      }
    }

    // ── Automatic trial purge — called by pg_cron, authenticated by a shared secret ──────
    //
    // The Terms (4.3, 7.6) and Privacy Policy (9) promise a lapsed trial's data is deleted 15 days
    // after the trial ends. `trial_purge_at` had been written at every signup since the form was
    // built and NOTHING acted on it, so that was a published retention commitment with no
    // mechanism -- the kind of gap a regulator reads as a misrepresentation rather than a bug.
    //
    // This runs unattended against live tenant data, which makes it the most dangerous code in the
    // product. Everything below is arranged around one question: what would have to be true for
    // this to delete a PAYING customer?
    //
    // The realistic path is an admin who takes payment and forgets to press "Convert to paid" --
    // `is_trial` is cleared by that button and by nothing else, so the flag alone is not evidence.
    // Hence six independent guards, ALL of which must hold, any one of which is enough to save a
    // real customer. They are evaluated in SQL by trials_due_for_purge() (migration
    // 20260903150000) rather than here, so the decision is auditable without reading Deno.
    //
    // This branch does NOT re-decide anything. It reads blocked_reason and obeys it. Two
    // implementations of "may this be deleted" is how a preview comes to lie -- the same reasoning
    // push_master_data's dry run already follows.
    if (action === 'purge_due_trials') {
      const given = req.headers.get('x-purge-secret') || ''
      const { data: secretRow } = await admin.from('app_secrets').select('purge_secret').eq('id', 1).single()
      const expected = secretRow?.purge_secret || ''
      // Length-independent comparison of fixed-size digests, same shape billing-export uses.
      const enc = new TextEncoder()
      const [gh, eh] = await Promise.all([
        crypto.subtle.digest('SHA-256', enc.encode(given)),
        crypto.subtle.digest('SHA-256', enc.encode(expected)),
      ])
      const ga = new Uint8Array(gh), ea = new Uint8Array(eh)
      let diff = expected ? 0 : 1
      for (let i = 0; i < ga.length; i++) diff |= ga[i] ^ ea[i]
      if (diff !== 0) return json({ error: 'Unauthorized' }, 401)

      // dry_run defaults TRUE. An unattended deleter whose default is "delete" is one typo in a
      // cron expression away from being fired by hand with no arguments.
      const dryRun = params?.dry_run !== false
      const { data: due, error: dueErr } = await admin.rpc('trials_due_for_purge')
      if (dueErr) return json({ error: dueErr.message }, 500)

      const results: Array<Record<string, unknown>> = []
      type DueRow = { client_id: string; client_name: string; blocked_reason: string | null }
      for (const row of (due || []) as DueRow[]) {
        // Held back by one of the six guards. Logged rather than skipped in silence: "four trials
        // are overdue and none has a backup" is something an operator has to be able to see and
        // act on (usually by opening Admin -> Clients so the pre-purge backup runs). A job that
        // quietly did nothing would look identical to one with nothing to do.
        if (row.blocked_reason) {
          if (!dryRun) {
            await admin.from('trial_purge_log').insert({
              client_id: row.client_id, client_name: row.client_name,
              outcome: 'skipped', detail: row.blocked_reason,
            })
          }
          results.push({ client_id: row.client_id, name: row.client_name, action: 'skipped', reason: row.blocked_reason })
          continue
        }
        if (dryRun) {
          results.push({ client_id: row.client_id, name: row.client_name, action: 'would_purge' })
          continue
        }
        try {
          // keep_staff_vault false: this is a real end-of-life delete, not Archive's reversible one.
          await deleteClientDataFor(admin, row.client_id, false)
          // The clients row SURVIVES, deactivated and stamped. Deleting it would take
          // legal_acceptances' client_id with it (ON DELETE SET NULL) and erase which business the
          // consent record belonged to -- and that record is retained 7 years by the same policy
          // this job exists to honour. Customer Data is deleted; the account shell is not.
          await admin.from('clients').update({
            is_active: false,
            trial_purged_at: new Date().toISOString(),
          }).eq('id', row.client_id)
          await admin.from('trial_purge_log').insert({
            client_id: row.client_id, client_name: row.client_name, outcome: 'purged',
          })
          results.push({ client_id: row.client_id, name: row.client_name, action: 'purged' })
        } catch (e) {
          const message = (e as Error).message
          // Logged and continued, never rethrown: one client whose delete hits an FK must not stop
          // the other five, and a job that dies silently mid-sweep is worse than one that reports.
          console.error('[purge_due_trials]', row.client_id, message)
          await admin.from('trial_purge_log').insert({
            client_id: row.client_id, client_name: row.client_name, outcome: 'failed', detail: message,
          })
          results.push({ client_id: row.client_id, name: row.client_name, action: 'failed', error: message })
        }
      }

      const purged = results.filter((r) => r.action === 'purged').length
      const skipped = results.filter((r) => r.action === 'skipped').length
      const failed = results.filter((r) => r.action === 'failed').length
      return json({ success: true, dry_run: dryRun, considered: results.length, purged, skipped, failed, results })
    }

    // ── Self-service trial signup — no admin auth required ────────────────────
    if (action === 'register_trial') {
      const { business_name, email, password, full_name, phone, accepted_legal, location, pan_no } = params
      if (!business_name || !email || !password) {
        return json({ error: 'business_name, email and password are required' }, 400)
      }
      // Outlet address and PAN exist so the approval call has something concrete to check
      // against (S697). Neither is validated beyond shape — a PAN check is the admin's job on the
      // call, not a regex's — and PAN stays optional because a café that has not registered yet
      // is still a real prospect. Both are bounded because they are attacker-typed text.
      const outletLocation = typeof location === 'string' ? location.trim().slice(0, 200) : ''
      const panNo          = typeof pan_no === 'string' ? pan_no.trim().slice(0, 20) : ''
      if (!outletLocation) return json({ error: 'Outlet address is required' }, 400)

      // The clickwrap is enforced HERE, not only by the checkbox. A consent control the browser can
      // skip is not a consent control -- the same reasoning as S531 invariant #3, where the POS and
      // Self-Service PIN lockouts were called around rather than through and therefore did nothing.
      // Anyone can POST this endpoint directly; if the acceptance were optional server-side, the
      // checkbox would be decoration and the ledger would have holes exactly where someone chose to
      // create them.
      //
      // Shape only. The version and hash describe what the BROWSER had loaded and displayed, which
      // is the fact worth recording -- the server cannot know it, and hardcoding a copy here would
      // be a second source of truth that drifts from src/legal/ on the first document edit.
      const LEGAL_DOC_TYPES = ['terms', 'privacy']
      const legalRows = []
      for (const docType of LEGAL_DOC_TYPES) {
        const entry = accepted_legal?.[docType]
        const version = typeof entry?.version === 'string' ? entry.version.trim() : ''
        const sha = typeof entry?.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : ''
        if (!version || version.length > 20 || !/^[0-9a-f]{64}$/.test(sha)) {
          return json({
            error: 'You must accept the Terms of Service and Privacy Policy to create an account.',
          }, 400)
        }
        legalRows.push({ docType, version, sha })
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email is required' }, 400)
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)
      if (String(business_name).length > 120) return json({ error: 'Business name is too long' }, 400)

      // Rate limit. This action is unauthenticated by design (it IS the public signup form), so
      // without a cap a loop here creates unbounded auth users + clients + profiles, each of which
      // then sits in Admin -> Clients until trial_purge_at 22 days later.
      //
      // Per-IP first, then a global circuit breaker so a distributed attempt still can't run away
      // — a real product doing 30 genuine signups in one hour is a good problem to notice manually.
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'
      // Read off the request, never from the payload. Trimmed because a user agent is
      // attacker-controlled text and there is no reason to store an unbounded string.
      const userAgent = (req.headers.get('user-agent') || '').slice(0, 400) || null
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()

      const { count: ipCount } = await admin
        .from('trial_signup_attempts').select('id', { count: 'exact', head: true })
        .eq('ip', ip).gte('created_at', since)
      if ((ipCount ?? 0) >= 3) {
        return json({ error: 'Too many signup attempts from this network. Please try again in an hour.' }, 429)
      }

      const { count: globalCount } = await admin
        .from('trial_signup_attempts').select('id', { count: 'exact', head: true })
        .gte('created_at', since)
      if ((globalCount ?? 0) >= 30) {
        return json({ error: 'Signups are temporarily paused. Please try again shortly.' }, 429)
      }

      // Recorded BEFORE the attempt, so a failing loop (duplicate email, weak password) burns
      // quota exactly like a succeeding one — otherwise the cheapest attack is to keep failing.
      await admin.from('trial_signup_attempts').insert({ ip, email })

      // Breached-password screening, the server-side half of NIST SP 800-63B-4's blocklist
      // control. weakPasswordReason() in the browser is the offline half (common passwords,
      // repeats, runs, business-name/email derivations) and is explicitly NOT a boundary — an
      // attacker just skips it. This is the half that isn't skippable.
      //
      // It has to live here rather than being delegated to Supabase's "Leaked Password
      // Protection" toggle, because that toggle cannot see this call: GoTrue runs its HIBP
      // check inside checkPasswordStrength(), and adminUserCreate — which is what
      // auth.admin.createUser() hits — never calls it. Enabling the dashboard setting does
      // nothing for the signup form. (It does cover ResetPassword.js and the IMS/HR resets,
      // which go through the user-facing and adminUserUpdate paths respectively.)
      //
      // Fail-open on null, loudly: a HIBP outage must not take signups down. Same stance as the
      // PIN lockout RPCs, and for the same reason — the availability cost of failing closed is
      // certain while the security cost of failing open is probabilistic.
      const pwned = await isPasswordPwned(password)
      if (pwned === true) {
        return json({
          error: 'This password has appeared in a known data breach. Please choose a different one.',
        }, 400)
      }
      if (pwned === null) {
        console.error('[register_trial] HIBP check unavailable — signup allowed without breach screening')
      }

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: full_name || business_name },
      })
      if (authErr || !authData?.user) {
        return json({ error: authErr?.message || 'Failed to create user' }, 400)
      }

      const now          = new Date()
      const trialExpires = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000) // +7 days
      const trialPurge   = new Date(now.getTime() + 22 * 24 * 60 * 60 * 1000) // +7+15 days

      // The trial is Growth with all three modules on (S697): Starter is "record and comply" and
      // contains none of the numbers that sell the product, and a 7-day trial never reaches a
      // month close, so Recipe Costing / Recipe Margin are the first pages that can show a figure
      // the same afternoon. This is safe to hand out because nobody sees it until an admin
      // approves the signup — trial_approved_at stays NULL here and getAccessState() locks the
      // client with reason 'pending' until AdminClients.approveTrial stamps it. The trial dates
      // are still written now so an abandoned, never-approved signup ages into the purge job
      // like any other; approval restarts them from the approval day.
      const { data: client, error: clientErr } = await admin
        .from('clients')
        .insert({
          name:              business_name,
          location:          outletLocation,
          pan_no:            panNo || null,
          contact_person:    full_name || business_name,
          contact_phone:     phone || null,
          plan:              'growth',
          is_trial:          true,
          trial_approved_at: null,
          trial_start_date:  now.toISOString(),
          trial_expires_at:  trialExpires.toISOString(),
          trial_purge_at:    trialPurge.toISOString(),
          ims_enabled:       true,
          hr_enabled:        true,
          pos_enabled:       true,
          // Owner decision (S758): a trial tries Crest Customization too. The column exists
          // from migration 20260919100000; the trigger there refuses it without pos_enabled.
          customization_enabled: true,
        })
        .select('id')
        .single()

      if (clientErr || !client) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: clientErr?.message || 'Failed to create client' }, 400)
      }

      // handle_new_user trigger may have already inserted a bare profile row;
      // upsert ensures we always write our values regardless
      const { error: profileErr } = await admin.from('profiles').upsert({
        id:        authData.user.id,
        full_name: full_name || business_name,
        role:      'client',
        client_id: client.id,
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        await admin.from('clients').delete().eq('id', client.id)
        return json({ error: profileErr.message }, 400)
      }

      // The acceptance ledger. Written LAST, because it references the client and the user, and
      // BLOCKING with a rollback rather than best-effort -- an account that exists with no record
      // of what its owner agreed to is precisely the state this whole change exists to end, so
      // creating one silently would be worse than refusing the signup. Same rollback shape the
      // profile failure above already uses.
      const acceptedAt = new Date().toISOString()
      const { error: legalErr } = await admin.from('legal_acceptances').insert(
        legalRows.map((r) => ({
          client_id:      client.id,
          client_name:    business_name,
          user_id:        authData.user.id,
          user_email:     email,
          doc_type:       r.docType,
          doc_version:    r.version,
          content_sha256: r.sha,
          method:         'clickwrap_trial',
          accepted_at:    acceptedAt,
          ip_address:     ip,
          user_agent:     userAgent,
        }))
      )
      if (legalErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        await admin.from('clients').delete().eq('id', client.id)
        console.error('[register_trial] legal_acceptances insert failed:', legalErr.message)
        return json({ error: 'Could not record your acceptance of the Terms. Please try again.' }, 500)
      }

      // Summary state for the admin list. Not the record of authority -- legal_acceptances is --
      // so a failure here is logged and swallowed rather than undoing a completed signup.
      const { error: statusErr } = await admin
        .from('clients').update({ agreement_status: 'trial_accepted' }).eq('id', client.id)
      if (statusErr) {
        console.error('[register_trial] agreement_status update failed:', statusErr.message)
      }

      return json({ success: true })
    }

    // ── All other actions require admin auth ──────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const caller = createClient(url, anon, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authErr } = await caller.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)
    admin = createClient(url, svc, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { 'x-crest-actor': user.id } },
    })

    // Use service-role client to fetch profile — RLS on profiles can block anon+JWT reads;
    // identity is already verified above via caller.auth.getUser()
    const { data: profile } = await admin
      .from('profiles').select('role, full_name, pos_role, pos_email, ims_role, hr_self_service, hr_role, client_id, active_client_id, pos_discount_limit, pos_allow_void, pos_blocked_at, settlement_blocked_by').eq('id', user.id).single()

    // ── POS/IMS/HR manager-accessible actions (before admin-only guard) ──────
    // isCallerOwner must exclude every staff-account marker (pos_role, pos_email, ims_role,
    // hr_self_service, hr_role) — a staff account of one type has none of the other markers set, so
    // without excluding all of them here it would incorrectly pass as "owner" for privileged actions
    // outside its own domain (e.g. an HR self-service PIN account calling create_pos_staff).
    // pos_email since S752: a PIN login whose pos_role was cleared passed as the Owner.
    const isCallerAdmin      = profile?.role === 'admin'
    // S809 3i: a blocked POS manager (POS Staff or Final Settlement) manages nobody, as
    // pos_caller_has_rank refuses it every rank. Its sessions are ended by the block, so this is the
    // second line, for a token still alive.
    const isCallerPosManager = profile?.pos_role === 'manager' && !profile?.pos_blocked_at && !profile?.settlement_blocked_by
    const isCallerImsManager = profile?.ims_role === 'manager'
    const isCallerHrManager  = profile?.hr_role === 'manager'
    const isCallerOwner      = profile?.role === 'client' && !profile?.pos_role && !profile?.pos_email && !profile?.ims_role && !profile?.hr_self_service && !profile?.hr_role
    const isPosPrivileged    = isCallerAdmin || isCallerPosManager || isCallerOwner
    const isImsPrivileged    = isCallerAdmin || isCallerImsManager || isCallerOwner
    const isHrPrivileged     = isCallerAdmin || isCallerHrManager || isCallerOwner
    // The client a non-admin caller is acting FOR: the outlet it has switched to, else its home.
    // my_client_id()'s own rule, and the one every RLS policy and page already uses — so a grouped
    // Owner managing a sibling outlet's staff reaches that outlet's employees and logins instead of
    // being refused as if they belonged to another tenant (S748 open item, closed S750).
    // active_client_id is privilege-bearing and written only by set_active_outlet(), which checks
    // group membership and profile_outlet_access, and a revoke clears it — so trusting it here
    // grants no reach RLS does not already grant. Legal acceptance follows the same rule (S789):
    // each outlet is its own clients row carrying its own legal entity, and the gate that asks
    // for acceptance reads the switched outlet's ledger.
    const callerClientId     = profile?.active_client_id || profile?.client_id

    // A window left on one outlet after the same login switched outlet elsewhere (another tab, the
    // phone) or lost that outlet: the page still sends the outlet it shows, while this function acts
    // for the outlet the account is in now, so a create landed in the other outlet and the page said
    // "created" (S798 GAP-OUTLETS-2). A non-admin request that names a client must name this one.
    // Admin is exempt: for an operator client_id IS the target, chosen in Admin → Clients.
    if (!isCallerAdmin && params?.client_id && params.client_id !== callerClientId) {
      return json({
        error: 'This window is showing a different outlet from the one your account is now working in. Reload the page.',
        code: 'outlet_mismatch',
      }, 409)
    }

    // ── Legal acceptance, recorded server-side ───────────────────────────────
    // Both actions below exist for one reason: the address, the identity and the timestamp on an
    // acceptance row have to be OBSERVED, not supplied. A browser cannot know its own public IP,
    // and a subject that chooses its own attribution has not been attributed. So the payload
    // carries only which document version was on screen; everything that makes the row evidence is
    // read here off the request and the verified JWT.
    if (action === 'record_legal_acceptance') {
      // Owner only. Staff are not the contracting party -- a waiter with a POS PIN cannot bind the
      // business, and letting them clear the gate would defeat the point of having one.
      if (!isCallerOwner && !isCallerAdmin) return json({ error: 'Forbidden' }, 403)
      if (!callerClientId) return json({ error: 'No client on this account' }, 400)

      const accepted = params?.accepted_legal
      const rows = []
      for (const docType of ['terms', 'privacy']) {
        const entry = accepted?.[docType]
        if (!entry) continue
        const version = typeof entry.version === 'string' ? entry.version.trim() : ''
        const sha = typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : ''
        if (!version || version.length > 20 || !/^[0-9a-f]{64}$/.test(sha)) {
          return json({ error: 'Malformed acceptance payload' }, 400)
        }
        rows.push({ docType, version, sha })
      }
      if (!rows.length) return json({ error: 'Nothing to accept' }, 400)

      // The outlet the Owner is acting for, not the home one. AuthContext reads this client's
      // ledger to decide the gate, and RLS (my_client_id()) shows the Owner only this client's
      // rows while switched. Recording against the home client left a grouped Owner at the gate on
      // a sibling outlet, with each press adding a row to the home client's ledger (S789).
      const { data: clientRow } = await admin
        .from('clients').select('name').eq('id', callerClientId).single()

      const { error: insErr } = await admin.from('legal_acceptances').insert(
        rows.map((r) => ({
          client_id:      callerClientId,
          client_name:    clientRow?.name || null,
          user_id:        user.id,
          user_email:     user.email || null,
          doc_type:       r.docType,
          doc_version:    r.version,
          content_sha256: r.sha,
          method:         'clickwrap_reaccept',
          ip_address:     (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown',
          user_agent:     (req.headers.get('user-agent') || '').slice(0, 400) || null,
        }))
      )
      // Loud, not swallowed: the caller is being held at a blocking gate, and telling them the
      // acceptance landed when it did not would leave them stuck on the next page load with no
      // explanation. There is an action they can take -- try again -- so this belongs in front of
      // them rather than in console.error alone.
      if (insErr) {
        console.error('[record_legal_acceptance] insert failed:', insErr.message)
        return json({ error: 'Could not record your acceptance. Please try again.' }, 500)
      }
      return json({ success: true })
    }

    if (action === 'record_paper_agreement') {
      // Admin only. This records a physical signed and stamped contract, which only the operator
      // handling it can attest to -- a client recording its own countersignature would be the same
      // self-attestation problem in a different coat.
      if (!isCallerAdmin) return json({ error: 'Forbidden' }, 403)

      const { client_id, signatory_name, signatory_title, signed_on_date, stamped, accepted_legal } = params
      if (!client_id || !signatory_name || !signed_on_date) {
        return json({ error: 'client_id, signatory_name and signed_on_date are required' }, 400)
      }

      const { data: clientRow, error: clientLookupErr } = await admin
        .from('clients').select('id, name').eq('id', client_id).single()
      if (clientLookupErr || !clientRow) return json({ error: 'Client not found' }, 404)

      // One row per document the paper agreement incorporates by reference, plus the agreement
      // itself. Part D of the agreement lists the Terms and Privacy versions and their hashes, so
      // signing it is an acceptance of those exact versions -- recording only the agreement would
      // lose which text the signature actually covered.
      const rows = []
      for (const docType of ['subscription_agreement', 'terms', 'privacy']) {
        const entry = accepted_legal?.[docType]
        if (!entry) continue
        const version = typeof entry.version === 'string' ? entry.version.trim() : ''
        const sha = typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : ''
        if (!version || version.length > 20 || !/^[0-9a-f]{64}$/.test(sha)) {
          return json({ error: 'Malformed acceptance payload' }, 400)
        }
        rows.push({ docType, version, sha })
      }
      if (!rows.length) return json({ error: 'Nothing to record' }, 400)

      const { error: insErr } = await admin.from('legal_acceptances').insert(
        rows.map((r) => ({
          client_id:       clientRow.id,
          client_name:     clientRow.name,
          user_id:         null,
          user_email:      null,
          doc_type:        r.docType,
          doc_version:     r.version,
          content_sha256:  r.sha,
          method:          'signed_paper',
          signatory_name:  String(signatory_name).slice(0, 200),
          signatory_title: signatory_title ? String(signatory_title).slice(0, 200) : null,
          signed_on_date:  signed_on_date,
          stamped:         stamped === true,
          // Who at Crest recorded it, taken from the verified JWT. An operator action on a legal
          // record needs a name against it.
          recorded_by:     user.id,
          ip_address:      (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown',
          user_agent:      (req.headers.get('user-agent') || '').slice(0, 400) || null,
        }))
      )
      if (insErr) {
        console.error('[record_paper_agreement] insert failed:', insErr.message)
        return json({ error: insErr.message }, 500)
      }

      const { error: statusErr } = await admin.from('clients').update({
        agreement_status:    'paper_signed',
        agreement_signed_at: new Date(signed_on_date).toISOString(),
      }).eq('id', clientRow.id)
      if (statusErr) return json({ error: statusErr.message }, 500)

      return json({ success: true })
    }

    if (action === 'create_pos_staff' || action === 'reset_pos_pin' || action === 'delete_pos_staff' || action === 'update_pos_role'
        || action === 'block_pos_staff' || action === 'unblock_pos_staff') {
      if (!isPosPrivileged) return json({ error: 'Forbidden' }, 403)
    }
    if (action === 'create_ims_staff' || action === 'reset_ims_password' || action === 'delete_ims_staff' || action === 'update_ims_role'
        || action === 'create_ims_pin_staff' || action === 'reset_ims_pin') {
      if (!isImsPrivileged) return json({ error: 'Forbidden' }, 403)
    }
    if (action === 'create_hr_staff' || action === 'reset_hr_password' || action === 'delete_hr_staff' || action === 'update_hr_role') {
      if (!isHrPrivileged) return json({ error: 'Forbidden' }, 403)
    }

    // ── Target resolution for every staff-management action ───────────────────
    // Until this existed, each of reset_pos_pin / reset_ims_password / reset_hr_password /
    // delete_*_staff verified ONLY that the target shared the caller's client_id — and never that
    // the target was actually a staff account. The client Owner shares that client_id, so any
    // module manager could:
    //
    //   reset_ims_password { userId: <owner id> }  -> overwrite the Owner's password, then log in
    //                                                 as them (the Owner's email comes free from
    //                                                 get_ims_eligible_users, which any same-client
    //                                                 session could call -- see the companion
    //                                                 migration 20260810130000)
    //   delete_ims_staff   { userId: <owner id> }  -> delete the Owner's auth user outright; the
    //                                                 "managers can only be deleted by admin"
    //                                                 guard misses the Owner, whose ims_role is
    //                                                 NULL rather than 'manager'
    //   update_ims_role    { userId: <owner id> }  -> stamp a staff marker on the Owner, which per
    //                                                 the negative isOwner test silently demotes
    //                                                 them out of Owner-level access
    //
    // requireStaffTarget() closes all three: a non-admin caller may only act on an account that
    // already carries the staff marker for the module being acted on, and never on an admin.
    // Admin callers are deliberately exempt from the marker requirement -- resetting a locked-out
    // Owner's password is legitimate operator support, and admin already has unrestricted
    // createUser/deleteUser below.
    //
    // The marker per module mirrors that module's own RESTRICTIVE RLS predicate exactly, so
    // "is a POS staff account" means the same thing here as it does to the database:
    //   pos -> pos_email IS NOT NULL   (same filter as get_pos_device_staff / is_pos_pin_staff())
    //   ims -> ims_role  IS NOT NULL   (same filter as is_ims_staff())
    //   hr  -> hr_role   IS NOT NULL   (same filter as is_hr_role_staff())
    const STAFF_MARKER: Record<string, (t: Record<string, unknown>) => boolean> = {
      pos: t => !!t.pos_email,
      ims: t => !!t.ims_role,
      hr:  t => !!t.hr_role,
      // Self-Service is its own axis, not an HR rank: these accounts carry hr_self_service with
      // no hr_role at all, so the `hr` marker above would reject them. Keeping them separate also
      // means delete_hr_self_service_login can never be aimed at an HR *manager* account.
      self_service: t => t.hr_self_service === true,
    }
    const MODULE_LABEL: Record<string, string> = { pos: 'POS', ims: 'IMS', hr: 'HR', self_service: 'HR Self-Service' }

    // The POS powers and lock stamp are read for reset_pos_pin (S809 1f): its power check compares the
    // target's discount limit and Void against the caller's, and its audit row says whether the reset
    // ended a lockout. The two block stamps are read for Block / Unblock (S809 3i).
    async function loadTarget(userId: string) {
      const { data } = await admin
        .from('profiles')
        .select('id, role, client_id, full_name, pos_role, pos_email, pos_discount_limit, pos_allow_void, pos_pin_locked_until, pos_blocked_at, settlement_blocked_by, ims_role, ims_email, hr_role, hr_self_service')
        .eq('id', userId).single()
      return data as Record<string, unknown> | null
    }

    // Returns a ready-to-send error response, or null when the target is acceptable.
    function requireStaffTarget(target: Record<string, unknown> | null, module: string) {
      if (!target) return json({ error: 'User not found' }, 404)
      if (target.role === 'admin') return json({ error: 'Forbidden' }, 403)
      if (isCallerAdmin) return null
      if (target.client_id !== callerClientId) return json({ error: 'Forbidden' }, 403)
      if (!STAFF_MARKER[module](target)) {
        return json({ error: `This is not a ${MODULE_LABEL[module]} staff account and cannot be managed from here` }, 403)
      }
      return null
    }

    // A module MANAGER may act on the staff and supervisors of that module -- never on a peer
    // manager, and never on their own row. Both were open until S729. delete_ims_staff refused
    // a manager target ("Managers can only be deleted by admin"), but update_ims_role had no
    // rank check on the TARGET at all, so a manager could clear a peer manager's role -- locking
    // them out of every IMS page -- and then delete the now-staff account: the delete guard was
    // two requests long. reset_ims_password had the same gap, which is worse: a manager could
    // set a peer manager's password and sign in as them. And nothing stopped a manager setting
    // their OWN row to "No Access", after which only the Owner or an admin can restore them.
    //
    // The Owner is exempt alongside admin. The Owner created these managers, and the old
    // "admin only" delete rule had never actually kept a manager from an Owner who could clear
    // the role first -- so the rule it replaces is the one people believed was in force.
    // requireStaffTarget() runs first, so `target` is already a same-client staff account of the
    // module (or the caller is admin, who returns before any of this).
    function requireManageableTarget(target: Record<string, unknown>, module: string, opts: { allowSelf?: boolean } = {}) {
      if (isCallerAdmin || isCallerOwner) return null
      const label = MODULE_LABEL[module]
      if (!opts.allowSelf && target.id === user.id) {
        return json({ error: `Your own ${label} login cannot be changed from here — ask the account owner or an administrator` }, 403)
      }
      if (target[`${module}_role`] === 'manager') {
        return json({ error: `Another ${label} manager's login can only be changed by the account owner or an administrator` }, 403)
      }
      return null
    }

    // Converting a login with no staff markers into module staff demotes it out of Owner status
    // (the negative isOwner test). That is the point of "Existing User" mode when a client has
    // several plain logins -- but converting the ONLY one leaves the client with no Owner at all:
    // nobody who can use Existing User mode, reach the Suite features, or manage a manager.
    // Counts the plain logins on the target's client; the caller is already admin or Owner here.
    async function isLastOwnerLogin(target: Record<string, unknown>) {
      const { count, error } = await admin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', target.client_id as string).eq('role', 'client')
        .is('pos_role', null).is('pos_email', null).is('ims_role', null).is('hr_role', null)
        .or('hr_self_service.is.null,hr_self_service.eq.false')
      // A guard that drops its read passes vacuously -- treat "could not count" as "last".
      if (error) return true
      return (count ?? 0) <= 1
    }
    const LAST_OWNER_MSG = 'This is the only Owner login for this client — giving it a staff role would leave nobody with Owner access. Create the staff member as a new login instead.'

    // A staff login ALWAYS carries a rank (S752, decided with Aashish). Owner is the absence of every
    // staff marker, so a login created with no rank — or one whose rank was cleared with "No Access"
    // — became a full Owner: every salary, all IMS and POS data, and Owner rights in this very
    // function. An HR manager could create a login they controlled and clear it. "No Access" is now
    // Delete on the pages, and the server refuses the shapes that minted an Owner.
    const NO_RANK_MSG = 'A staff login always has an access level. To take someone\'s access away, delete their login — clearing the level would turn it into a full Owner login.'
    // Manager rank is granted by the Owner or the operator only (S752, decided for HR): a manager
    // minting a peer is a manager nobody below the Owner can undo.
    const MANAGER_GRANT_MSG = 'Only the account owner can give a login Manager access.'

    // A POS manager cannot hand out more than they hold (S754, decided with Aashish — the rule HR
    // uses for Manager rank, applied to the two per-staff powers on POS Staff). Before this a manager
    // capped at 10% could give a waiter an unlimited discount, or Void permission the manager did not
    // have, and then use that waiter's PIN. NULL discount limit = unlimited, so a capped manager can
    // never grant NULL. Admin and the Owner are exempt. Returns a ready-to-send error or null.
    const callerDiscountCap: number | null =
      profile?.pos_discount_limit === null || profile?.pos_discount_limit === undefined ? null : Number(profile.pos_discount_limit)
    // The one comparison behind that rule: which of the two POS powers the caller does not hold.
    // `limit` undefined means "not being set" and is not compared; NULL is unlimited. Granting a
    // power (refusePosPowerEscalation) and resetting the PIN of someone who already holds one
    // (reset_pos_pin, S809 1f) are refused on this same test, each in its own words, so the two can
    // never disagree about what "more" means. Admin and the Owner hold every power.
    function posPowerBeyondCaller(limit: unknown, allowVoid: unknown): 'unlimited_discount' | 'higher_discount' | 'void' | null {
      if (isCallerAdmin || isCallerOwner) return null
      if (limit !== undefined && callerDiscountCap !== null) {
        if (limit === null) return 'unlimited_discount'
        if (typeof limit === 'number' && limit > callerDiscountCap) return 'higher_discount'
      }
      if (allowVoid === true && profile?.pos_allow_void !== true) return 'void'
      return null
    }
    function refusePosPowerEscalation(limit: unknown, allowVoid: unknown) {
      const gap = posPowerBeyondCaller(limit, allowVoid)
      if (gap === 'unlimited_discount') {
        return json({ error: `You can give a discount limit of up to ${callerDiscountCap}% — your own limit. "No limit" is more than that; ask the account owner.` }, 403)
      }
      if (gap === 'higher_discount') {
        return json({ error: `You can give a discount limit of up to ${callerDiscountCap}% — your own limit. Ask the account owner for more.` }, 403)
      }
      if (gap === 'void') {
        return json({ error: 'Your own login cannot void bills, so you cannot give Void permission to anyone. Ask the account owner.' }, 403)
      }
      return null
    }
    // Acting on a login that holds a power the caller lacks (S809 1f for a PIN reset; S809 3i for
    // Block, Unblock and Delete, the same rule). The target's powers go through the grant test
    // unchanged; a limit the read did not return counts as unlimited (refused for a capped caller)
    // rather than as "not being set" (not compared). `doing` finishes "only the account owner can …",
    // e.g. "reset Bina's PIN". Returns a ready-to-send error or null.
    function posPowerRefusal(target: Record<string, unknown>, doing: string) {
      const targetLimit = target.pos_discount_limit === null || target.pos_discount_limit === undefined
        ? null : Number(target.pos_discount_limit)
      const gap = posPowerBeyondCaller(targetLimit, target.pos_allow_void)
      if (!gap) return null
      const who = whoOf(target)
      const why = gap === 'void'
        ? `${who} can void bills and your login cannot`
        : gap === 'unlimited_discount'
          ? `${who} has no discount limit and yours is ${callerDiscountCap}%`
          : `${who} can give discounts of up to ${targetLimit}% and yours stop at ${callerDiscountCap}%`
      return json({ error: `${why}, so only the account owner can ${doing}.` }, 403)
    }
    // "Bina" / "This staff member", and "Bina's" / "their", for the sentences above and below.
    function whoOf(target: Record<string, unknown>) {
      const n = typeof target.full_name === 'string' ? target.full_name.trim() : ''
      return n || 'This staff member'
    }
    function possessive(target: Record<string, unknown>) {
      const n = typeof target.full_name === 'string' ? target.full_name.trim() : ''
      return n ? `${n}'s` : 'their'
    }

    // ── Create a POS staff member — name + PIN, auto-generated email ──────────
    // Optional employee_id links the new POS account to an existing hr_employees record
    // (client has both HR + POS) — full_name is then taken from that employee, not retyped.
    if (action === 'create_pos_staff') {
      const targetClientId = isCallerAdmin ? params.client_id : callerClientId
      if (!targetClientId) return json({ error: 'client_id required' }, 400)

      const { pin, pos_role, pos_job_title, pos_team, employee_id, pos_discount_limit, pos_allow_void } = params
      let { full_name } = params
      if (!pin) return json({ error: 'pin is required' }, 400)
      if (!/^\d{4,6}$/.test(pin)) return json({ error: 'PIN must be 4–6 digits' }, 400)

      const validRoles = ['staff', 'supervisor', 'manager']
      if (!pos_role) return json({ error: NO_RANK_MSG }, 400)
      if (!validRoles.includes(pos_role)) return json({ error: 'Invalid pos_role' }, 400)
      // Manager rank is granted by the Owner or the operator only (S754, the HR rule).
      if (pos_role === 'manager' && !(isCallerAdmin || isCallerOwner)) return json({ error: MANAGER_GRANT_MSG }, 403)

      const validTeams = ['foh', 'kitchen', 'bar']
      if (pos_team && !validTeams.includes(pos_team)) return json({ error: 'Invalid pos_team' }, 400)

      if (pos_discount_limit !== undefined && pos_discount_limit !== null &&
          (typeof pos_discount_limit !== 'number' || pos_discount_limit < 0 || pos_discount_limit > 100)) {
        return json({ error: 'Invalid pos_discount_limit' }, 400)
      }
      if (pos_allow_void !== undefined && typeof pos_allow_void !== 'boolean') {
        return json({ error: 'Invalid pos_allow_void' }, 400)
      }
      const createEscalation = refusePosPowerEscalation(pos_discount_limit, pos_allow_void)
      if (createEscalation) return createEscalation
      // The column's default is NULL = unlimited, so a login a capped manager creates without naming a
      // limit would hold more than its creator. It starts at the creator's own cap instead.
      const createDiscountLimit = pos_discount_limit !== undefined
        ? pos_discount_limit
        : (!(isCallerAdmin || isCallerOwner) && callerDiscountCap !== null ? callerDiscountCap : undefined)

      if (employee_id) {
        const { data: employee } = await admin
          .from('hr_employees').select('id, full_name, client_id')
          .eq('id', employee_id).eq('client_id', targetClientId).single()
        if (!employee) return json({ error: 'Employee not found' }, 400)

        const { data: existingLink } = await admin
          .from('profiles').select('id').eq('hr_employee_id', employee_id).not('pos_email', 'is', null).maybeSingle()
        if (existingLink) return json({ error: 'This employee already has a POS staff account' }, 400)

        full_name = employee.full_name
      }
      if (!full_name) return json({ error: 'full_name is required' }, 400)

      // Generate a stable internal email — staff never see or type this
      const slug   = full_name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
      const suffix = Math.random().toString(36).slice(2, 7)
      const email  = `${slug}_${suffix}@pos.internal`

      // The stored password is derived, never the PIN itself — see _shared/pinPassword.ts. The
      // account's own generated email is the salt, and both this call and pos-staff-login
      // compute the same value from it.
      const { pepper: posPepper } = await getAppSecrets(admin)
      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password:      await derivePinPassword(email, pin, posPepper),
        email_confirm: true,
        user_metadata: { full_name },
      })
      if (authErr || !authData?.user) {
        return json({ error: authErr?.message || 'Failed to create user' }, 400)
      }

      const { error: profileErr } = await admin.from('profiles').upsert({
        id:            authData.user.id,
        full_name,
        role:          'client',
        client_id:     targetClientId,
        pos_role:      pos_role || null,
        pos_job_title: pos_job_title || null,
        pos_email:     email,
        hr_employee_id: employee_id || null,
        // Omitted (not `pos_team: pos_team || null`) so a brand-new row falls through to the
        // column's own DEFAULT 'foh' rather than an explicit null clashing with the NOT NULL.
        ...(pos_team ? { pos_team } : {}),
        ...(createDiscountLimit !== undefined ? { pos_discount_limit: createDiscountLimit } : {}),
        ...(pos_allow_void !== undefined ? { pos_allow_void } : {}),
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: profileErr.message }, 400)
      }

      await vaultPin(authData.user.id, targetClientId, 'pos', pin)

      return json({ success: true, userId: authData.user.id })
    }

    // ── Rebuild PIN logins from a backup's roster + vault ────────────────────────────────────
    //
    // Restores POS and HR Self-Service accounts after a full client delete, from the roster and
    // ciphertext captured by the frontend export. Platform admin only — this creates accounts in
    // bulk with known credentials, which is not something a client-side manager should be able
    // to drive.
    //
    // Faithful rather than approximate, because both halves of the original derivation survive
    // in the backup: the account's generated *.pos.internal / *.hr.internal email is exported
    // verbatim, and the PIN is recoverable from the vault ciphertext. Recreating with the same
    // email + same PIN yields the same derived password, so staff sign in exactly as before.
    //
    // Password accounts (IMS staff, HR staff, Owner) are deliberately NOT handled here: their
    // login is a real human email address that the export intentionally does not carry, and
    // their passwords are user-chosen 8+ character secrets that are never vaulted (S539). They
    // come back as a named to-recreate list instead.
    if (action === 'restore_staff_accounts') {
      if (!isCallerAdmin) return json({ error: 'Forbidden' }, 403)

      const { client_id, roster, vault } = params
      if (!client_id || !Array.isArray(roster)) {
        return json({ error: 'client_id and roster are required' }, 400)
      }

      const { pepper, vaultKey } = await getAppSecrets(admin)
      const cipherByUser: Record<string, string> = Object.fromEntries(
        (vault || []).map((v: { user_id: string; pin_cipher: string }) => [v.user_id, v.pin_cipher]),
      )

      const restored: Array<{ full_name: string; kind: string }> = []
      const manual:   Array<{ full_name: string; kind: string; reason: string }> = []

      // A leaver's till or count PIN comes back blocked, as their Final Settlement left it (S798,
      // DATABASE-1) — the vaulted PIN would otherwise recreate it working. Only while that settlement
      // came back finalized; the Restore restores settlements before it calls this. Tens of rows.
      const { data: finalizedRows, error: finalizedErr } = await admin.from('hr_final_settlements')
        .select('id').eq('client_id', client_id).eq('status', 'finalized')
      if (finalizedErr) return json({ error: `could not read the restored settlements: ${finalizedErr.message}` }, 500)
      const finalizedIds = new Set((finalizedRows || []).map((s: { id: string }) => s.id))

      for (const p of roster) {
        // Three PIN kinds now (S737): POS, Self-Service and IMS stock count. An account is
        // restorable when it has a generated login email in the roster AND a vaulted PIN — the
        // two halves of the original derivation. A `kind` added without a branch here does not
        // fail: it silently reports a restorable account as unrecoverable, which is why the
        // email column and this list have to move together.
        const isPos = !!p.pos_email
        const isSelfService = !!p.hr_self_service_email
        const isImsCount = !!p.ims_email
        const email = isPos ? p.pos_email : isSelfService ? p.hr_self_service_email : p.ims_email
        const kindLabel = isPos ? 'POS' : isSelfService ? 'Self-Service' : 'IMS count'
        const vaultKind: 'pos' | 'hr_self_service' | 'ims_count' =
          isPos ? 'pos' : isSelfService ? 'hr_self_service' : 'ims_count'

        if (!isPos && !isSelfService && !isImsCount) {
          manual.push({
            full_name: p.full_name || '(unnamed)',
            kind: p.ims_role ? 'IMS staff' : p.hr_role ? 'HR staff' : 'Owner / admin',
            reason: 'password account — email and password are not in the backup',
          })
          continue
        }

        const cipher = cipherByUser[p.id]
        if (!cipher || !vaultKey) {
          manual.push({ full_name: p.full_name, kind: kindLabel, reason: 'no vaulted PIN in this backup' })
          continue
        }

        let pin: string
        try {
          pin = await decryptPin(cipher, vaultKey)
        } catch {
          // Almost always means pin_vault_key was rotated after this backup was taken.
          manual.push({ full_name: p.full_name, kind: kindLabel, reason: 'vaulted PIN could not be decrypted (vault key rotated?)' })
          continue
        }

        const { data: authData, error: authErr } = await admin.auth.admin.createUser({
          email,
          password:      await derivePinPassword(email, pin, pepper),
          email_confirm: true,
          user_metadata: { full_name: p.full_name },
        })
        if (authErr || !authData?.user) {
          manual.push({ full_name: p.full_name, kind: kindLabel, reason: authErr?.message || 'account creation failed' })
          continue
        }

        const { error: profileErr } = await admin.from('profiles').upsert({
          id:        authData.user.id,
          full_name: p.full_name,
          role:      'client',
          client_id,
          ...(isPos ? {
            pos_role:            p.pos_role || null,
            pos_job_title:       p.pos_job_title || null,
            pos_email:           email,
            pos_discount_limit:  p.pos_discount_limit ?? null,
            pos_allow_void:      p.pos_allow_void ?? false,
            // Omitted when absent so the column's own DEFAULT 'foh' applies rather than a null
            // colliding with NOT NULL — same reasoning as create_pos_staff.
            ...(p.pos_team ? { pos_team: p.pos_team } : {}),
            // A login POS Staff blocked comes back blocked (S809 3i); the ban follows below. Who
            // blocked it is not kept: that login's id did not survive the restore.
            ...(p.pos_blocked_at ? { pos_blocked_at: p.pos_blocked_at } : {}),
          } : isSelfService ? {
            hr_self_service:       true,
            hr_self_service_email: email,
          } : {
            // A count PIN is always ims_role 'staff' — create_ims_pin_staff fixes it there for
            // the same reason, so the roster's value is taken only as a fallback.
            ims_role:      p.ims_role || 'staff',
            ims_job_title: p.ims_job_title || null,
            ims_email:     email,
          }),
          // hr_employee_id points at the restored hr_employees row, which keeps its original id
          // because restoreClientData inserts rows verbatim.
          hr_employee_id: p.hr_employee_id || null,
        }, { onConflict: 'id' })

        if (profileErr) {
          await admin.auth.admin.deleteUser(authData.user.id)
          manual.push({ full_name: p.full_name, kind: kindLabel, reason: profileErr.message })
          continue
        }

        await vaultPin(authData.user.id, client_id, vaultKind, pin)

        // Final Settlement blocks till and stock logins (never Self-Service, which access_blocked on
        // the employee ends), so only those two kinds carry the stamp.
        let blocked = false
        if ((isPos || isImsCount) && p.settlement_blocked_by && finalizedIds.has(p.settlement_blocked_by)) {
          const { error: banErr } = await admin.auth.admin.updateUserById(authData.user.id, { ban_duration: LEAVER_BAN })
          let stampErr: { message: string } | null = null
          if (!banErr) {
            const { error } = await admin.from('profiles')
              .update({ settlement_blocked_by: p.settlement_blocked_by }).eq('id', authData.user.id)
            stampErr = error
          }
          if (banErr || stampErr) {
            // A working login for someone settled out is the thing this step exists to prevent, so
            // it does not stay: removed and named for the operator instead.
            await admin.auth.admin.deleteUser(authData.user.id)
            manual.push({ full_name: p.full_name, kind: kindLabel, reason: `left out — settled leaver, and the block could not be re-applied (${(banErr || stampErr)?.message})` })
            continue
          }
          blocked = true
        }
        // S809 3i: the same for a till login POS Staff blocked. The stamp went in with the profile
        // above; without the ban the vaulted PIN would sign them straight back in.
        let posBlocked = false
        if (!blocked && isPos && p.pos_blocked_at) {
          const { error: banErr } = await admin.auth.admin.updateUserById(authData.user.id, { ban_duration: LEAVER_BAN })
          if (banErr) {
            await admin.auth.admin.deleteUser(authData.user.id)
            manual.push({ full_name: p.full_name, kind: kindLabel, reason: `left out — POS Staff had blocked this login, and the block could not be re-applied (${banErr.message})` })
            continue
          }
          posBlocked = true
        }
        restored.push({
          full_name: p.full_name,
          kind: blocked ? `${kindLabel}, blocked (settled leaver)` : posBlocked ? `${kindLabel}, blocked (POS Staff)` : kindLabel,
        })
      }

      return json({ success: true, restored, manual })
    }

    // ── Re-link staff logins to the records a Restore brought back (S798, DATABASE-1) ────────
    //
    // Archive deletes hr_employees and hr_final_settlements and keeps every login, and both profile
    // links to them (hr_employee_id, settlement_blocked_by) are ON DELETE SET NULL. The Restore
    // brings the rows back under their old ids and, before this, nothing pointed at them again:
    // Crest Staff refused every sign-in, Final Settlement found no login to block, the own-record
    // guards fell back to the employee's email, and hr-push reached nobody. hr_employee_id is written
    // only when a login is created and guard_profiles_privileged_columns keeps the browser off it, so
    // this is the one repair. The Restore calls it after restoreClientData whether or not logins
    // exist; a login restore_staff_accounts just recreated has a new id and is not in the roster.
    //
    // A link is filled only where it is NULL, only to a record that exists in this client, and never
    // where it would give an employee a second login of a kind that allows one. A leaver's block comes
    // back only while the restored settlement is still finalized, and its ban is re-asserted. A backup
    // from before the export carried settlement_blocked_by infers it the way Final Settlement chose:
    // a till, stock or HR login, linked to that leaver, already banned, settled in the current
    // employment. Tens of rows per client, so the three reads are not paged.
    if (action === 'relink_staff_accounts') {
      if (!isCallerAdmin) return json({ error: 'Forbidden' }, 403)

      const { client_id, roster } = params
      if (!client_id || !Array.isArray(roster)) {
        return json({ error: 'client_id and roster are required' }, 400)
      }

      const [liveRes, empRes, finRes] = await Promise.all([
        admin.from('profiles')
          .select('id, full_name, hr_employee_id, settlement_blocked_by, pos_blocked_at, pos_email, hr_self_service, ims_role, hr_role')
          .eq('client_id', client_id),
        admin.from('hr_employees').select('id, join_date').eq('client_id', client_id),
        admin.from('hr_final_settlements').select('id, employee_id, last_working_date')
          .eq('client_id', client_id).eq('status', 'finalized'),
      ])
      const readErr = liveRes.error || empRes.error || finRes.error
      if (readErr) return json({ error: `could not read the restored client: ${readErr.message}` }, 500)

      type Live = { id: string; full_name: string | null; hr_employee_id: string | null; settlement_blocked_by: string | null;
        pos_blocked_at: string | null; pos_email: string | null; hr_self_service: boolean | null; ims_role: string | null; hr_role: string | null }
      const live = (liveRes.data || []) as Live[]
      const liveById = new Map(live.map(p => [p.id, p]))
      const joinOf = new Map((empRes.data || []).map((e: { id: string; join_date: string | null }) => [e.id, e.join_date]))
      const finalized = (finRes.data || []) as Array<{ id: string; employee_id: string; last_working_date: string }>
      const finalizedIds = new Set(finalized.map(s => s.id))
      // The settlement that closed an employee's CURRENT employment (a join date after the settled last
      // day is a rehire, S791) — the one Final Settlement would have blocked their logins under.
      const currentSettlementOf = (employeeId: string) => {
        const join = joinOf.get(employeeId)
        return finalized
          .filter(s => s.employee_id === employeeId && (!join || s.last_working_date >= join))
          .sort((a, b) => (a.last_working_date < b.last_working_date ? 1 : -1))[0] || null
      }
      // profiles_hr_employee_self_service_unique and profiles_hr_employee_pos_unique: one login of each
      // of those kinds per employee.
      const held = {
        selfService: new Set(live.filter(p => p.hr_self_service && p.hr_employee_id).map(p => p.hr_employee_id as string)),
        pos: new Set(live.filter(p => p.pos_email && p.hr_employee_id).map(p => p.hr_employee_id as string)),
      }

      const relinked: string[] = []
      const reblocked: string[] = []
      const skipped: Array<{ full_name: string; reason: string }> = []

      for (const r of roster) {
        const p = r?.id ? liveById.get(r.id) : undefined
        if (!p) continue
        const name = p.full_name || r.full_name || '(unnamed)'
        const patch: Record<string, string> = {}

        if (!p.hr_employee_id && r.hr_employee_id) {
          if (!joinOf.has(r.hr_employee_id)) {
            skipped.push({ full_name: name, reason: 'their employee record is not in this restore' })
          } else if ((p.hr_self_service && held.selfService.has(r.hr_employee_id)) || (p.pos_email && held.pos.has(r.hr_employee_id))) {
            skipped.push({ full_name: name, reason: 'another login of the same kind is already linked to that employee' })
          } else {
            patch.hr_employee_id = r.hr_employee_id
            if (p.hr_self_service) held.selfService.add(r.hr_employee_id)
            if (p.pos_email) held.pos.add(r.hr_employee_id)
          }
        }

        const employeeId = patch.hr_employee_id || p.hr_employee_id
        const blocksLogins = !!(p.pos_email || p.ims_role || p.hr_role)
        // Read once, only when a block is in question. A failed read counts as not banned: an inferred
        // block is then not made, and a named one re-bans, which is harmless if it already was.
        let banned: boolean | null = null
        const isBanned = async () => {
          if (banned === null) {
            const { data: u } = await admin.auth.admin.getUserById(p.id)
            const until = u?.user?.banned_until ? Date.parse(u.user.banned_until) : NaN
            banned = Number.isFinite(until) && until > Date.now()
          }
          return banned
        }
        let blockBy: string | null = null
        // A login POS Staff blocked keeps that block as its own (S809 3i): its ban is POS Staff's, and
        // a settlement stamp on top would let a Reopen lift it. Finalize leaves such a login alone too.
        if (!p.settlement_blocked_by && !p.pos_blocked_at && blocksLogins) {
          if (r.settlement_blocked_by) {
            if (finalizedIds.has(r.settlement_blocked_by)) blockBy = r.settlement_blocked_by
          } else if (!('settlement_blocked_by' in r) && employeeId) {
            const s = currentSettlementOf(employeeId)
            if (s && await isBanned()) blockBy = s.id
          }
        }

        if (blockBy) {
          if (!(await isBanned())) {
            const { error: banErr } = await admin.auth.admin.updateUserById(p.id, { ban_duration: LEAVER_BAN })
            if (banErr) {
              skipped.push({ full_name: name, reason: `settled leaver, but the login could not be blocked (${banErr.message}) — block it by hand` })
              blockBy = null
            }
          }
          if (blockBy) patch.settlement_blocked_by = blockBy
        }

        if (!Object.keys(patch).length) continue
        const { error: upErr } = await admin.from('profiles').update(patch).eq('id', p.id).eq('client_id', client_id)
        if (upErr) { skipped.push({ full_name: name, reason: upErr.message }); continue }
        if (patch.hr_employee_id) relinked.push(name)
        if (patch.settlement_blocked_by) reblocked.push(name)
      }

      return json({ success: true, relinked, reblocked, skipped })
    }

    // ── Enable HR Employee Self-Service — PIN login, mirrors create_pos_staff exactly ────────
    // Admin, the client Owner, or an HR MANAGER of that client (S748, decided with Aashish). The
    // Employees page has always been an HR-manager page and rendered Enable / Remove to them, while
    // this gate refused them with a bare "Forbidden" — so the one person running HR could not give
    // an employee their app. POS managers stay out: HR access is not delegated to a floor manager.
    if (action === 'create_hr_self_service_login') {
      if (!isHrPrivileged) return json({ error: 'Forbidden' }, 403)

      const targetClientId = isCallerAdmin ? params.client_id : callerClientId
      if (!targetClientId) return json({ error: 'client_id required' }, 400)

      const { employee_id, pin } = params
      if (!employee_id || !pin) return json({ error: 'employee_id and pin are required' }, 400)
      if (!/^\d{4,6}$/.test(pin)) return json({ error: 'PIN must be 4–6 digits' }, 400)

      const { data: employee } = await admin
        .from('hr_employees').select('id, full_name, client_id')
        .eq('id', employee_id).eq('client_id', targetClientId).single()
      if (!employee) return json({ error: 'Employee not found' }, 400)

      // One login per employee. Nothing checked this before S748, so a second Enable created a
      // second account for the same person rather than a new PIN (profiles_hr_employee_self_service_
      // unique is the backstop). A failed read refuses: a check that could not run has not passed.
      const { data: existingLogin, error: existingErr } = await admin
        .from('profiles').select('id')
        .eq('hr_employee_id', employee.id).eq('hr_self_service', true)
        .limit(1)
      if (existingErr) return json({ error: 'Could not check for an existing Self-Service login — nothing was created. Try again.' }, 500)
      if (existingLogin && existingLogin.length > 0) {
        return json({ error: `${employee.full_name} already has a Self-Service login. To give them a new PIN, Remove it first, then Enable again.` }, 409)
      }

      const slug   = employee.full_name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
      const suffix = Math.random().toString(36).slice(2, 7)
      const email  = `${slug}_${suffix}@hr.internal`

      // Derived, not the raw PIN — same treatment as create_pos_staff above, and the reason
      // hr-selfservice-login must derive with this same email before signing in.
      const { pepper: hrPepper } = await getAppSecrets(admin)
      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password:      await derivePinPassword(email, pin, hrPepper),
        email_confirm: true,
        user_metadata: { full_name: employee.full_name },
      })
      if (authErr || !authData?.user) {
        return json({ error: authErr?.message || 'Failed to create user' }, 400)
      }

      const { error: profileErr } = await admin.from('profiles').upsert({
        id:                     authData.user.id,
        full_name:              employee.full_name,
        role:                   'client',
        client_id:              targetClientId,
        hr_employee_id:         employee.id,
        hr_self_service:        true,
        hr_self_service_email:  email,
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: profileErr.message }, 400)
      }

      await vaultPin(authData.user.id, targetClientId, 'hr_self_service', pin)

      return json({ success: true, userId: authData.user.id })
    }

    // ── Remove an HR Self-Service login ───────────────────────────────────────
    // The inverse of create_hr_self_service_login, and it did not exist until S571: Enable was a
    // one-way door, so revoking a departed employee's payslip/leave portal access meant deleting
    // the auth user by hand in SQL (found doing exactly that during the S569 PIN-vault cleanup).
    // Note this is NOT the same as hr_employees.access_blocked (S563), which suspends login while
    // keeping the account — this deletes the login outright. The employee RECORD is untouched:
    // profiles.hr_employee_id is ON DELETE SET NULL in that direction, and payroll history hangs
    // off hr_employees, not off this login. Same gate as creating one: admin, Owner or HR manager.
    if (action === 'delete_hr_self_service_login') {
      if (!isHrPrivileged) return json({ error: 'Forbidden' }, 403)

      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const ssTarget = await loadTarget(userId)
      const ssDenied = requireStaffTarget(ssTarget, 'self_service')
      if (ssDenied) return ssDenied

      // Deleting the auth user cascades profiles (profiles_id_fkey) and, through it, the
      // staff_pin_vault row — so no orphaned PIN ciphertext is left behind.
      const { error: delErr } = await admin.auth.admin.deleteUser(userId)
      if (delErr) return json({ error: delErr.message }, 400)
      return json({ success: true })
    }

    // ── Update a POS staff member's role ─────────────────────────────────────
    if (action === 'update_pos_role') {
      const { userId, pos_role, pos_job_title, pos_team, pos_discount_limit, pos_allow_void } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const validRoles = ['staff', 'supervisor', 'manager']
      // Sent but empty is "No Access": refused, the same as HR and IMS (S752).
      if (pos_role !== undefined && !pos_role) return json({ error: NO_RANK_MSG }, 400)
      if (pos_role && !validRoles.includes(pos_role)) return json({ error: 'Invalid pos_role' }, 400)

      const validTeams = ['foh', 'kitchen', 'bar']
      if (pos_team && !validTeams.includes(pos_team)) return json({ error: 'Invalid pos_team' }, 400)

      if (pos_discount_limit !== undefined && pos_discount_limit !== null &&
          (typeof pos_discount_limit !== 'number' || pos_discount_limit < 0 || pos_discount_limit > 100)) {
        return json({ error: 'Invalid pos_discount_limit' }, 400)
      }

      if (pos_allow_void !== undefined && typeof pos_allow_void !== 'boolean') {
        return json({ error: 'Invalid pos_allow_void' }, 400)
      }

      // POS has no "assign an existing login" mode -- every one of PosStaff.jsx's four callers
      // (updateRole / updateTeam / updateDiscountLimit / updateAllowVoid) acts on a row from
      // get_pos_staff_list, which returns PIN accounts only. So the target must already be one.
      const posTarget = await loadTarget(userId)
      const posDenied = requireStaffTarget(posTarget, 'pos')
      if (posDenied) return posDenied
      // A POS manager changes waiters and supervisors — never a peer manager, never their own login
      // (S754, decided with Aashish; the S729 rule HR and IMS already follow).
      const posManageDenied = requireManageableTarget(posTarget!, 'pos')
      if (posManageDenied) return posManageDenied
      if (pos_role === 'manager' && !(isCallerAdmin || isCallerOwner)) return json({ error: MANAGER_GRANT_MSG }, 403)
      const posEscalation = refusePosPowerEscalation(pos_discount_limit, pos_allow_void)
      if (posEscalation) return posEscalation

      // Every field here is only written when the caller actually sent it. updateTeam/
      // updateDiscountLimit/updateAllowVoid each call this action with only their one field set
      // (e.g. { pos_team } alone) — pos_role was previously unconditional (`pos_role || null`),
      // which meant any one of those team/discount/void-only calls silently wiped the staff
      // member's role to "No Access" on every use, not just on page load. Found live (S517)
      // testing the new Discount Limit field: setting a limit on a Staff-role account reset their
      // role to null on the very next page load. Symmetric with the reverse case this function
      // already guarded against — PosStaff.jsx's silent mismatched-role auto-fix loop (init())
      // calls this action with just { pos_role, pos_job_title }, which is why pos_team's own
      // conditional write was added first (S431) but pos_role's wasn't.
      const updatePayload = {}
      if (pos_role !== undefined) updatePayload.pos_role = pos_role || null
      if (pos_job_title !== undefined) updatePayload.pos_job_title = pos_job_title || null
      if (pos_team !== undefined) updatePayload.pos_team = pos_team || 'foh'
      if (pos_discount_limit !== undefined) updatePayload.pos_discount_limit = pos_discount_limit
      if (pos_allow_void !== undefined) updatePayload.pos_allow_void = pos_allow_void

      if (Object.keys(updatePayload).length === 0) return json({ error: 'No fields to update' }, 400)

      const { error: updateErr } = await admin.from('profiles')
        .update(updatePayload)
        .eq('id', userId)
      if (updateErr) return json({ error: updateErr.message }, 400)
      return json({ success: true })
    }

    // ── Delete a POS staff member ─────────────────────────────────────────────
    if (action === 'delete_pos_staff') {
      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const posTarget = await loadTarget(userId)
      const posDenied = requireStaffTarget(posTarget, 'pos')
      if (posDenied) return posDenied
      // Was "Managers can only be deleted by admin", which also refused the Owner. A manager's login
      // is the Owner's or the operator's to remove, and a manager cannot remove their own (S754).
      const posDeleteManageDenied = requireManageableTarget(posTarget!, 'pos')
      if (posDeleteManageDenied) return posDeleteManageDenied
      // The S809 1f rule, as for a PIN reset (S809 3i).
      const posDeletePowerDenied = posPowerRefusal(posTarget!, `delete ${possessive(posTarget!)} login`)
      if (posDeletePowerDenied) return posDeletePowerDenied

      // ── Delete only a login that recorded nothing (S809 ACCESS-5; owner decision Q17 (a)) ──────
      // Deleting the auth user deletes the profile, and every key from the till's tables to it is ON
      // DELETE SET NULL: the bills, shifts, cash entries, tickets and credit notes it recorded kept
      // their rows and lost the name, while the confirm said the names stayed. A login with any such
      // row is refused with the way out the owner chose, Block. Decided here, from the database's
      // own list of those columns (pos_login_recorded_rows), never by the page. A failed read refuses:
      // an unread history is not an empty one.
      const posWho = whoOf(posTarget!)
      const { data: recorded, error: recErr } = await admin.rpc('pos_login_recorded_rows', { p_profile_id: userId })
      if (recErr) {
        console.error('[admin-user-ops] delete_pos_staff: could not read what the login recorded — refusing:', recErr.code, recErr.message)
        return json({ error: `Could not check whether ${posWho} has recorded anything at the till, so the login was not deleted and their PIN still works. Try again in a moment.` }, 503)
      }
      const recordedRows = (recorded || []) as Array<{ table_name: string; column_name: string; n: number }>
      if (recordedRows.length > 0) {
        return json({
          error: `${posWho} has ${describePosLoginRecords(recordedRows)} at the till, so deleting this login would take their name off those records. Block the login instead: it can no longer sign in, and the name stays on every record.`,
          code: 'pos_login_has_records',
          records: recordedRows,
        }, 409)
      }

      const { error: delErr } = await admin.auth.admin.deleteUser(userId)
      if (delErr) return json({ error: delErr.message }, 400)
      return json({ success: true })
    }

    // ── Block / Unblock a POS login (S809 ACCESS-5; owner decision Q17 (a), 2026-10-09) ────────
    // Removing a leaver's till login BLOCKS it: they can no longer sign in, every session they have is
    // ended, and the profile stays, so their name stays on every bill, shift, ticket and note they
    // recorded. Final Settlement's shape (S753/S798) for a restaurant with no HR. Unblock is for a
    // block made by mistake. Whoever may delete a POS login may block or unblock one, on the same
    // rules: requireStaffTarget, requireManageableTarget (never a peer manager, never your own) and
    // the S809 1f power rule. The block itself is pos_set_login_blocked (service role only): the
    // stamp, the ban and the session end in one transaction, so a failure leaves nothing half done.
    if (action === 'block_pos_staff' || action === 'unblock_pos_staff') {
      const blocking = action === 'block_pos_staff'
      const verb = blocking ? 'block' : 'unblock'
      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const blockTarget = await loadTarget(userId)
      const blockDenied = requireStaffTarget(blockTarget, 'pos')
      if (blockDenied) return blockDenied
      // The operator skips requireStaffTarget's marker test; a block is for till logins only.
      if (!blockTarget!.pos_email) return json({ error: 'This is not a till (PIN) login, so it cannot be blocked from POS Staff.' }, 400)
      const blockManageDenied = requireManageableTarget(blockTarget!, 'pos')
      if (blockManageDenied) return blockManageDenied
      const blockPowerDenied = posPowerRefusal(blockTarget!, `${verb} ${possessive(blockTarget!)} login`)
      if (blockPowerDenied) return blockPowerDenied

      const who = whoOf(blockTarget!)
      const settlementSentence = `${who}'s logins were blocked by their Final Settlement in HR, so this one is unblocked there, not here: reopen the settlement, or rehire them in HR → Employees.`
      // Said before the call, in words: the database refuses the same (pos_login_settlement_blocked).
      if (blockTarget!.settlement_blocked_by) {
        return json({ error: blocking ? `${who}'s login is already blocked by their Final Settlement in HR.` : settlementSentence, code: 'pos_login_settlement_blocked' }, 409)
      }

      const { data: outcome, error: blockErr } = await admin.rpc('pos_set_login_blocked', {
        p_profile_id: userId, p_blocked: blocking, p_actor: user.id,
      })
      if (blockErr) {
        if (blockErr.hint === 'pos_unblock_leaver') {
          return json({ error: `HR shows ${who} as no longer working here, so the login stays blocked. If they are coming back, rehire them in HR → Employees first, then unblock it.`, code: 'pos_unblock_leaver' }, 409)
        }
        if (blockErr.hint === 'pos_login_settlement_blocked') {
          return json({ error: settlementSentence, code: 'pos_login_settlement_blocked' }, 409)
        }
        if (blockErr.hint === 'pos_login_not_found') {
          return json({ error: 'This is not a till (PIN) login, so it cannot be blocked from POS Staff.' }, 400)
        }
        console.error(`[admin-user-ops] ${action}: pos_set_login_blocked failed:`, blockErr.code, blockErr.message)
        // An answer from the database (it carries a code) means its one transaction rolled back, so
        // nothing changed. No answer at all proves nothing either way.
        return blockErr.code
          ? json({ error: `${who}'s login was not ${blocking ? 'blocked' : 'unblocked'}: the server could not finish, and nothing was changed. Try again in a moment.` }, 500)
          : json({ error: `It is not known whether ${who}'s login was ${blocking ? 'blocked' : 'unblocked'}: the answer was lost on the way. Reload the page to see, then try again.` }, 503)
      }
      return json({ success: true, outcome })
    }

    // ── Reset a POS staff PIN ─────────────────────────────────────────────────
    if (action === 'reset_pos_pin') {
      const { userId, pin } = params
      if (!userId || !pin) return json({ error: 'userId and pin are required' }, 400)
      if (!/^\d{4,6}$/.test(pin)) return json({ error: 'PIN must be 4–6 digits' }, 400)

      // Same client AND actually a POS PIN account. The client_id check alone used to let a POS
      // manager point this at the Owner (who shares the client_id) and overwrite their password
      // with a 4-6 digit PIN they chose -- see requireStaffTarget's note above.
      const pinTarget = await loadTarget(userId)
      const pinDenied = requireStaffTarget(pinTarget, 'pos')
      if (pinDenied) return pinDenied
      // Not allowSelf: every non-Owner caller here is a POS manager, and a manager's login — their own
      // included — is changed by the Owner or the operator (S754). A PIN reset on a peer manager was
      // a way to sign in as them.
      const pinManageDenied = requireManageableTarget(pinTarget!, 'pos')
      if (pinManageDenied) return pinManageDenied
      // Nor the PIN of someone holding a power the caller lacks (S809 ACCESS-3; owner decision Q5 (a),
      // 2026-10-08: the S754 rule applied to resets). A new PIN lets whoever chose it sign in as that
      // person, so a manager capped at 10% with no Void could reset the PIN of a cashier the Owner
      // trusted with Void or no cap, then void or discount as her — the escalation S754 closed for
      // grants, reached through the reset instead. The target's powers are what the reset hands the
      // caller, so they go through the grant test unchanged (posPowerRefusal, shared with Block,
      // Unblock and Delete since S809 3i; the sentence is the one 1f wrote).
      const pinPowerDenied = posPowerRefusal(pinTarget!, `reset ${possessive(pinTarget!)} PIN`)
      if (pinPowerDenied) return pinPowerDenied

      // Salt must be this account's existing email, not a freshly generated one — the login
      // side derives from whatever pos_email currently holds, so a reset that salted with
      // anything else would produce a password nobody can ever reproduce.
      if (!pinTarget?.pos_email) return json({ error: 'This account has no POS login to reset' }, 400)

      // This is the one call in the codebase that Supabase's leaked-password protection would
      // have broken outright: updateUserById routes through GoTrue's adminUserUpdate, which
      // DOES run checkPasswordStrength (unlike adminUserCreate), and every 4-6 digit PIN is in
      // the HIBP corpus. Creating staff would have kept working while resetting their PIN
      // failed with "password is known to be weak" on every possible value. Deriving first is
      // what makes the toggle safe to enable.
      const { pepper: resetPepper } = await getAppSecrets(admin)
      const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
        password: await derivePinPassword(pinTarget.pos_email, pin, resetPepper),
      })
      if (updateErr) return json({ error: updateErr.message }, 400)

      await vaultPin(userId, pinTarget.client_id, 'pos', pin)

      // A reset ends a lockout (S809 DOCS-1; owner decision Q6 (a), 2026-10-08). The 15-minute lock
      // protects the OLD PIN against guessing; the new one starts with five fresh tries. Before this,
      // pos-staff-login's reservation refused the new PIN until the lock ran out, while the till told
      // the waiter to ask for exactly this reset. record_pos_pin_attempt(success) is the call a correct
      // sign-in makes: service role only, a DEFINER body (so guard_profiles_privileged_columns lets it
      // through), and log_audit() skips a change to the lockout columns alone. It runs after the
      // password, never before: a reset that failed must not hand a guesser five more tries at the old
      // PIN. A failure here leaves a working new PIN behind the old lock, so it is reported, not thrown.
      const pinLockStamp = pinTarget.pos_pin_locked_until
      const pinLockedUntil = typeof pinLockStamp === 'string' && Date.parse(pinLockStamp) > Date.now() ? pinLockStamp : null
      const { error: unlockErr } = await admin.rpc('record_pos_pin_attempt', { p_staff_id: userId, p_success: true })
      if (unlockErr) console.error('[admin-user-ops] reset_pos_pin: PIN changed but the lockout was not cleared:', unlockErr.message)

      // Every reset leaves a trace (S809 ACCESS-3): who reset which login's PIN, and when — never the
      // PIN. Nothing recorded one before: the password lives in auth.users and the vault has no audit
      // trigger. Filed beside the PIN reveal's VIEW row (table staff_pin_vault, "Staff PIN" on the
      // Audit Log page), so one filter answers "who has touched this login's PIN". Best-effort after
      // the change, like the reveal's row: the PIN is already changed, and failing the request would
      // tell the manager it was not.
      const { data: pinClient } = await admin
        .from('clients').select('name').eq('id', pinTarget.client_id).maybeSingle()
      const { error: pinAuditErr } = await admin.from('audit_logs').insert({
        client_id:   pinTarget.client_id,
        client_name: pinClient?.name ?? null,
        user_id:     user.id,
        user_name:   profile?.full_name ?? user.email ?? null,
        table_name:  'staff_pin_vault',
        action:      'UPDATE',
        record_id:   userId,
        new_data:    {
          kind:         'pos',
          staff_member: pinTarget.full_name ?? null,
          pin_reset:    true,
          // Only when the login was locked out at the time: whether this reset ended it.
          ...(pinLockedUntil ? { lockout_ended: !unlockErr } : {}),
        },
      })
      if (pinAuditErr) console.error('[admin-user-ops] reset_pos_pin audit insert failed:', pinAuditErr.message)

      // lockout_cleared:false + locked_until tells POS Staff the new PIN is saved but the till will
      // refuse it until then. A client built before S809 1f ignores both and behaves as it always did.
      return json({ success: true, lockout_cleared: !unlockErr, locked_until: unlockErr ? pinLockedUntil : null })
    }

    // ── Reveal a staff member's PIN — PLATFORM ADMIN ONLY ─────────────────────
    // Not available to the client Owner or a POS manager, deliberately. They already have a
    // one-click Reset PIN on PosStaff.jsx, which stays the normal answer to "the waiter forgot
    // their PIN" — this exists for recovery and audit, not as a helpdesk shortcut. Widening it
    // to Owners is a one-line change to this gate, but it exposes every PIN to every client login.
    if (action === 'view_staff_pin') {
      if (!isCallerAdmin) return json({ error: 'Forbidden' }, 403)

      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const { data: vaultRow } = await admin
        .from('staff_pin_vault').select('pin_cipher, client_id, kind')
        .eq('user_id', userId).maybeSingle()

      // A missing row is normal, not an error state: accounts created before this feature have
      // no stored PIN and never will until someone resets it or the owner signs in through the
      // login functions' upgrade branch. Say so plainly rather than implying something broke.
      if (!vaultRow) {
        return json({
          error: 'No stored PIN for this account. It predates the PIN vault and has not been reset since. Use Reset PIN to set a new one.',
        }, 404)
      }

      const { vaultKey } = await getAppSecrets(admin)
      let revealedPin: string
      try {
        revealedPin = await decryptPin(vaultRow.pin_cipher, vaultKey)
      } catch {
        return json({
          error: 'The stored PIN could not be decrypted — app_secrets.pin_vault_key has changed since it was written. Use Reset PIN.',
        }, 500)
      }

      // Revealing a credential must leave a trace. Note what is stored: who looked, at which
      // account, when — never the PIN itself, which would put it in audit_logs in plaintext and
      // undo the point of encrypting it.
      const { data: vaultClient } = await admin
        .from('clients').select('name').eq('id', vaultRow.client_id).maybeSingle()

      await admin.from('audit_logs').insert({
        client_id:   vaultRow.client_id,
        client_name: vaultClient?.name ?? null,
        user_id:     user.id,
        user_name:   user.email,
        table_name:  'staff_pin_vault',
        action:      'VIEW',
        record_id:   userId,
        new_data:    { kind: vaultRow.kind, revealed: true },
      })

      return json({ pin: revealedPin })
    }

    // ── Rebuild every PIN account's password from the vault — PLATFORM ADMIN ONLY ─────────────
    // This is the whole reason the vault exists. Before it, PIN_PEPPER was neither recoverable
    // nor rotatable: PINs were stored nowhere, so losing or changing the pepper meant hand-
    // resetting every POS and Self-Service account across every client. With the plaintext PINs
    // recoverable, that becomes this one call.
    //
    // Run it when: the pepper is being rotated deliberately, or app_secrets was restored from a
    // backup that disagrees with what accounts were created under.
    if (action === 'rederive_pin_passwords') {
      if (!isCallerAdmin) return json({ error: 'Forbidden' }, 403)

      const { rotate_pepper } = params

      // An env pepper wins over the DB one inside getAppSecrets, so rotating the DB column while
      // PIN_PEPPER is set would silently do nothing and report success. Refuse instead.
      if (rotate_pepper && Deno.env.get('PIN_PEPPER')) {
        return json({
          error: 'PIN_PEPPER is set as an Edge Function secret and overrides the database value. Unset it (supabase secrets unset PIN_PEPPER) before rotating.',
        }, 400)
      }

      if (rotate_pepper) {
        const fresh = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        const { error: rotErr } = await admin
          .from('app_secrets').update({ pin_pepper: fresh, updated_at: new Date().toISOString() }).eq('id', 1)
        if (rotErr) return json({ error: 'Failed to rotate pepper: ' + rotErr.message }, 500)
        resetAppSecretsCache()
      }

      const { pepper, vaultKey } = await getAppSecrets(admin)

      // Every vaulted account, with the email each derivation must be salted with. There are
      // THREE salts — pos_email, hr_self_service_email and ims_email (S737) — picked by `kind`;
      // using the wrong one produces a password nobody can ever reproduce. A `kind` added to
      // staff_pin_vault without a branch here is an account this rotation silently bricks.
      const { data: vaulted } = await admin
        .from('staff_pin_vault').select('user_id, kind, pin_cipher')
      const { data: emails } = await admin
        .from('profiles').select('id, pos_email, hr_self_service_email, ims_email')
        .in('id', (vaulted ?? []).map((v: { user_id: string }) => v.user_id))

      const emailById = new Map(
        (emails ?? []).map((p: { id: string; pos_email: string | null; hr_self_service_email: string | null; ims_email: string | null }) => [p.id, p]),
      )
      const SALT_COLUMN: Record<string, 'pos_email' | 'hr_self_service_email' | 'ims_email'> = {
        pos: 'pos_email',
        hr_self_service: 'hr_self_service_email',
        ims_count: 'ims_email',
      }

      let updated = 0
      const failures: { user_id: string; reason: string }[] = []

      for (const row of vaulted ?? []) {
        try {
          const prof   = emailById.get(row.user_id) as Record<string, string | null> | undefined
          const column = SALT_COLUMN[row.kind as string]
          // An unknown kind must FAIL rather than fall through to a default salt: a wrong salt
          // produces a valid-looking password that no login can ever reproduce.
          if (!column) { failures.push({ user_id: row.user_id, reason: `unknown vault kind '${row.kind}'` }); continue }
          const salt = prof?.[column]
          if (!salt) { failures.push({ user_id: row.user_id, reason: 'no login email on profile' }); continue }

          const pin = await decryptPin(row.pin_cipher, vaultKey)
          const { error: upErr } = await admin.auth.admin.updateUserById(row.user_id, {
            password: await derivePinPassword(salt, pin, pepper),
          })
          if (upErr) { failures.push({ user_id: row.user_id, reason: upErr.message }); continue }
          updated++
        } catch (e) {
          failures.push({ user_id: row.user_id, reason: e instanceof Error ? e.message : 'unknown' })
        }
      }

      // Accounts with no vault row cannot be rebuilt — their PIN was never observed. Reported
      // rather than hidden, because those are exactly the ones that still need a manual reset.
      const { count: totalPinAccounts } = await admin
        .from('profiles').select('id', { count: 'exact', head: true })
        .or('pos_email.not.is.null,hr_self_service.eq.true,ims_email.not.is.null')

      return json({
        success:       true,
        rotated:       !!rotate_pepper,
        updated,
        failures,
        vaulted:       (vaulted ?? []).length,
        pin_accounts:  totalPinAccounts ?? null,
        unrecoverable: Math.max(0, (totalPinAccounts ?? 0) - (vaulted ?? []).length),
      })
    }

    // ── Create an IMS staff member — real email + password (not a PIN like POS) ───────────────
    // Optional employee_id links the new IMS account to an existing hr_employees record, same
    // pattern as create_pos_staff's HR Employee mode — full_name is taken from that employee.
    if (action === 'create_ims_staff') {
      const targetClientId = isCallerAdmin ? params.client_id : callerClientId
      if (!targetClientId) return json({ error: 'client_id required' }, 400)

      const { email, password, ims_role, ims_job_title, employee_id } = params
      let { full_name } = params
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email is required' }, 400)
      if (!password || password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

      // createUser bypasses GoTrue's HIBP check (adminUserCreate never calls
      // checkPasswordStrength), so the dashboard toggle cannot screen this path even when it is
      // switched on — while the matching reset_*_password action below, which goes through
      // adminUserUpdate, IS screened by it. Without this the two halves of the same feature
      // disagree: a manager could set a breached password at creation and then be refused that
      // exact password on reset. Fail-open on null and loudly, same stance as register_trial.
      const createPwned = await isPasswordPwned(password)
      if (createPwned === true) {
        return json({ error: 'This password has appeared in a known data breach. Please choose a different one.' }, 400)
      }
      if (createPwned === null) {
        console.error('[admin-user-ops] HIBP check unavailable — staff account created without breach screening')
      }

      const validRoles = ['staff', 'supervisor', 'manager']
      if (!ims_role) return json({ error: NO_RANK_MSG }, 400)
      if (!validRoles.includes(ims_role)) return json({ error: 'Invalid ims_role' }, 400)
      // S792 (MASTER-4): the S752 rule HR and POS already follow. An IMS manager minting a peer is a
      // manager nobody below the Owner can undo (requireManageableTarget refuses them).
      if (ims_role === 'manager' && !(isCallerAdmin || isCallerOwner)) return json({ error: MANAGER_GRANT_MSG }, 403)

      if (employee_id) {
        const { data: employee } = await admin
          .from('hr_employees').select('id, full_name, client_id')
          .eq('id', employee_id).eq('client_id', targetClientId).single()
        if (!employee) return json({ error: 'Employee not found' }, 400)

        // `error` read (S792, MASTER-8): a failed read, or two matching logins (which .maybeSingle()
        // reports as an error), read as "no existing IMS login" and a second one was created.
        const { data: existingLink, error: linkErr } = await admin
          .from('profiles').select('id').eq('hr_employee_id', employee_id).not('ims_role', 'is', null).limit(1)
        if (linkErr) return json({ error: `Could not check for an existing IMS login for this employee, so none was created: ${linkErr.message}` }, 503)
        if ((existingLink || []).length > 0) return json({ error: 'This employee already has an IMS staff account' }, 400)

        full_name = employee.full_name
      }
      if (!full_name) return json({ error: 'full_name is required' }, 400)

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name },
      })
      if (authErr || !authData?.user) {
        return json({ error: authErr?.message || 'Failed to create user' }, 400)
      }

      const { error: profileErr } = await admin.from('profiles').upsert({
        id:             authData.user.id,
        full_name,
        role:           'client',
        client_id:      targetClientId,
        ims_role:       ims_role || null,
        ims_job_title:  ims_job_title || null,
        hr_employee_id: employee_id || null,
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: profileErr.message }, 400)
      }

      return json({ success: true, userId: authData.user.id })
    }

    // ── Create an IMS stock-count PIN account — name + PIN, generated email (S737) ───────────
    // The POS-shaped sibling of create_ims_staff above: same ims_role axis, same restrictive
    // policies, but the login is a 4-6 digit PIN on a shared store-room tablet rather than an
    // email and password. A kitchen store-keeper needing an email address to count a shelf is
    // the friction this exists to remove.
    //
    // Deliberately fixed at ims_role 'staff'. The PIN account is count-only in the app
    // (AuthContext's imsCountOnly, enforced in ProtectedRoute), so a supervisor or manager PIN
    // would be a rank that cannot reach anything its rank unlocks.
    if (action === 'create_ims_pin_staff') {
      const targetClientId = isCallerAdmin ? params.client_id : callerClientId
      if (!targetClientId) return json({ error: 'client_id required' }, 400)

      const { pin, ims_job_title, employee_id } = params
      let { full_name } = params
      if (!pin) return json({ error: 'pin is required' }, 400)
      if (!/^\d{4,6}$/.test(pin)) return json({ error: 'PIN must be 4–6 digits' }, 400)

      if (employee_id) {
        const { data: employee } = await admin
          .from('hr_employees').select('id, full_name, client_id')
          .eq('id', employee_id).eq('client_id', targetClientId).single()
        if (!employee) return json({ error: 'Employee not found' }, 400)

        // `error` read (S792, MASTER-8): a failed read, or two matching logins (which .maybeSingle()
        // reports as an error), read as "no existing IMS login" and a second one was created.
        const { data: existingLink, error: linkErr } = await admin
          .from('profiles').select('id').eq('hr_employee_id', employee_id).not('ims_role', 'is', null).limit(1)
        if (linkErr) return json({ error: `Could not check for an existing IMS login for this employee, so none was created: ${linkErr.message}` }, 503)
        if ((existingLink || []).length > 0) return json({ error: 'This employee already has an IMS staff account' }, 400)

        full_name = employee.full_name
      }
      if (!full_name) return json({ error: 'full_name is required' }, 400)

      // A stable internal email nobody ever sees or types, matching create_pos_staff's shape.
      // get_ims_count_staff does not return it and ims-staff-login never echoes it back.
      const slug   = full_name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
      const suffix = Math.random().toString(36).slice(2, 7)
      const email  = `${slug}_${suffix}@ims.internal`

      // The stored password is derived, never the PIN itself — see _shared/pinPassword.ts.
      const { pepper: imsPepper } = await getAppSecrets(admin)
      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password:      await derivePinPassword(email, pin, imsPepper),
        email_confirm: true,
        user_metadata: { full_name },
      })
      if (authErr || !authData?.user) {
        return json({ error: authErr?.message || 'Failed to create user' }, 400)
      }

      const { error: profileErr } = await admin.from('profiles').upsert({
        id:             authData.user.id,
        full_name,
        role:           'client',
        client_id:      targetClientId,
        ims_role:       'staff',
        ims_job_title:  ims_job_title || null,
        ims_email:      email,
        hr_employee_id: employee_id || null,
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: profileErr.message }, 400)
      }

      await vaultPin(authData.user.id, targetClientId, 'ims_count', pin)

      return json({ success: true, userId: authData.user.id })
    }

    // ── Reset a count PIN (S737) ─────────────────────────────────────────────────────────────
    if (action === 'reset_ims_pin') {
      const { userId, pin } = params
      if (!userId || !pin) return json({ error: 'userId and pin are required' }, 400)
      if (!/^\d{4,6}$/.test(pin)) return json({ error: 'PIN must be 4–6 digits' }, 400)

      const pinTarget = await loadTarget(userId)
      const pinDenied = requireStaffTarget(pinTarget, 'ims')
      if (pinDenied) return pinDenied
      const pinRank = requireManageableTarget(pinTarget!, 'ims')
      if (pinRank) return pinRank

      // The salt must be this account's EXISTING ims_email: ims-staff-login derives from whatever
      // the column currently holds, so salting with a fresh one would produce a password nobody
      // can ever reproduce. A password-login IMS account has none, and takes reset_ims_password.
      if (!pinTarget?.ims_email) {
        return json({ error: 'This account signs in with an email and password — use Reset Password instead' }, 400)
      }

      const { pepper: resetImsPepper } = await getAppSecrets(admin)
      const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
        password: await derivePinPassword(pinTarget.ims_email as string, pin, resetImsPepper),
      })
      if (updateErr) return json({ error: updateErr.message }, 400)

      await vaultPin(userId, pinTarget.client_id as string, 'ims_count', pin)

      return json({ success: true })
    }

    // ── Update an IMS staff member's role ────────────────────────────────────
    if (action === 'update_ims_role') {
      const { userId, ims_role, ims_job_title } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const validRoles = ['staff', 'supervisor', 'manager']
      if (!ims_role) return json({ error: NO_RANK_MSG }, 400)
      if (!validRoles.includes(ims_role)) return json({ error: 'Invalid ims_role' }, 400)

      const targetProfile = await loadTarget(userId)
      if (!targetProfile) return json({ error: 'User not found' }, 404)
      if (targetProfile.role === 'admin') return json({ error: 'Forbidden' }, 403)
      if (!isCallerAdmin && targetProfile.client_id !== callerClientId) {
        return json({ error: 'Forbidden' }, 403)
      }
      // Unlike POS, IMS has an "Existing User" mode (ImsStaff.jsx:190) that deliberately targets a
      // login with NO staff markers yet -- which is exactly the shape of the client Owner's own
      // account. So this can't simply require an existing ims_role the way update_pos_role does.
      // Instead: converting a non-staff login into IMS staff is an Owner-level decision, because
      // stamping ims_role onto the Owner demotes them out of Owner access (the isOwner test in
      // AuthContext.js is a negative one). A module manager may still change or clear the role of
      // someone who is already IMS staff.
      if (ims_role && !targetProfile.ims_role && !(isCallerAdmin || isCallerOwner)) {
        return json({ error: 'Only the account owner or an administrator can give an existing login IMS access' }, 403)
      }
      if (ims_role && !targetProfile.ims_role && await isLastOwnerLogin(targetProfile)) {
        return json({ error: LAST_OWNER_MSG }, 400)
      }
      // S792 (MASTER-4): only the Owner (or the operator) makes someone an IMS Manager.
      if (ims_role === 'manager' && targetProfile.ims_role !== 'manager' && !(isCallerAdmin || isCallerOwner)) {
        return json({ error: MANAGER_GRANT_MSG }, 403)
      }
      // Already IMS staff: a manager may move staff and supervisors, not a peer manager or
      // themselves (see requireManageableTarget).
      if (targetProfile.ims_role) {
        const imsManageDenied = requireManageableTarget(targetProfile, 'ims')
        if (imsManageDenied) return imsManageDenied
      }
      // An account already marked POS PIN staff, HR self-service, or HR staff is RLS-blocked from
      // every pure-IMS / IMS+POS table regardless of ims_role (no_pos_pin_staff /
      // no_self_service_accounts / no_hr_role_staff don't check ims_role at all) — granting
      // ims_role here would look like it worked in the UI while every real read/write still
      // silently failed. (Clearing a role is refused above since S752 — it minted an Owner.)
      if (ims_role && (targetProfile?.pos_role || targetProfile?.hr_self_service || targetProfile?.hr_role)) {
        return json({ error: 'This account already has POS, HR self-service, or HR staff access and cannot also be an IMS staff account' }, 400)
      }
      // A counting PIN is a 4–6 digit login on a shared store-room tablet. create_ims_pin_staff
      // fixes its rank at 'staff' for that reason, and this action used to move it anywhere — a
      // manager-rank PIN passes ims_can_manage_counts(), skips the count scope and recount guards,
      // and satisfies isImsPrivileged here, i.e. creates logins and resets passwords (S756).
      // Admin included: there is no support case for a tablet PIN with a manager's reach.
      if (targetProfile.ims_email && ims_role !== 'staff') {
        return json({ error: 'A counting PIN is always Staff. To give this person more access, add them as an email login instead.' }, 400)
      }

      const { error: updateErr } = await admin.from('profiles')
        .update({ ims_role: ims_role || null, ims_job_title: ims_job_title || null })
        .eq('id', userId)
      if (updateErr) return json({ error: updateErr.message }, 400)
      return json({ success: true })
    }

    // ── Delete an IMS staff member ────────────────────────────────────────────
    if (action === 'delete_ims_staff') {
      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const imsTarget = await loadTarget(userId)
      const imsDenied = requireStaffTarget(imsTarget, 'ims')
      if (imsDenied) return imsDenied
      const imsManageDenied = requireManageableTarget(imsTarget!, 'ims')
      if (imsManageDenied) return imsManageDenied

      const { error: delErr } = await admin.auth.admin.deleteUser(userId)
      if (delErr) return json({ error: delErr.message }, 400)
      return json({ success: true })
    }

    // ── Reset an IMS staff member's password ──────────────────────────────────
    if (action === 'reset_ims_password') {
      const { userId, password } = params
      if (!userId || !password) return json({ error: 'userId and password are required' }, 400)
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

      // Same client AND actually an IMS staff account -- this was the sharpest edge of the
      // Owner-takeover chain: the Owner's id and real email both come back from
      // get_ims_eligible_users, so a client_id-only check meant one call here handed a manager a
      // working Owner login.
      const imsPwTarget = await loadTarget(userId)
      const imsPwDenied = requireStaffTarget(imsPwTarget, 'ims')
      if (imsPwDenied) return imsPwDenied
      // Resetting your own password is fine; resetting a peer manager's is a takeover.
      const imsPwManageDenied = requireManageableTarget(imsPwTarget!, 'ims', { allowSelf: true })
      if (imsPwManageDenied) return imsPwManageDenied

      const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password })
      if (updateErr) return json({ error: updateErr.message }, 400)

      return json({ success: true })
    }

    // ── Create an HR staff member — real email + password (not a PIN, not self-service) ───────
    // Structural mirror of create_ims_staff. Optional employee_id links the new HR-staff account
    // to an existing hr_employees record, same pattern as create_pos_staff's HR Employee mode.
    if (action === 'create_hr_staff') {
      const targetClientId = isCallerAdmin ? params.client_id : callerClientId
      if (!targetClientId) return json({ error: 'client_id required' }, 400)

      const { email, password, hr_role, hr_job_title, employee_id } = params
      let { full_name } = params
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email is required' }, 400)
      if (!password || password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

      // createUser bypasses GoTrue's HIBP check (adminUserCreate never calls
      // checkPasswordStrength), so the dashboard toggle cannot screen this path even when it is
      // switched on — while the matching reset_*_password action below, which goes through
      // adminUserUpdate, IS screened by it. Without this the two halves of the same feature
      // disagree: a manager could set a breached password at creation and then be refused that
      // exact password on reset. Fail-open on null and loudly, same stance as register_trial.
      const createPwned = await isPasswordPwned(password)
      if (createPwned === true) {
        return json({ error: 'This password has appeared in a known data breach. Please choose a different one.' }, 400)
      }
      if (createPwned === null) {
        console.error('[admin-user-ops] HIBP check unavailable — staff account created without breach screening')
      }

      const validRoles = ['staff', 'supervisor', 'manager']
      if (!hr_role) return json({ error: NO_RANK_MSG }, 400)
      if (!validRoles.includes(hr_role)) return json({ error: 'Invalid hr_role' }, 400)
      if (hr_role === 'manager' && !(isCallerAdmin || isCallerOwner)) return json({ error: MANAGER_GRANT_MSG }, 403)

      if (employee_id) {
        const { data: employee } = await admin
          .from('hr_employees').select('id, full_name, client_id')
          .eq('id', employee_id).eq('client_id', targetClientId).single()
        if (!employee) return json({ error: 'Employee not found' }, 400)

        const { data: existingLink } = await admin
          .from('profiles').select('id').eq('hr_employee_id', employee_id).not('hr_role', 'is', null).maybeSingle()
        if (existingLink) return json({ error: 'This employee already has an HR staff account' }, 400)

        full_name = employee.full_name
      }
      if (!full_name) return json({ error: 'full_name is required' }, 400)

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name },
      })
      if (authErr || !authData?.user) {
        return json({ error: authErr?.message || 'Failed to create user' }, 400)
      }

      const { error: profileErr } = await admin.from('profiles').upsert({
        id:             authData.user.id,
        full_name,
        role:           'client',
        client_id:      targetClientId,
        hr_role:        hr_role || null,
        hr_job_title:   hr_job_title || null,
        hr_employee_id: employee_id || null,
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: profileErr.message }, 400)
      }

      return json({ success: true, userId: authData.user.id })
    }

    // ── Update an HR staff member's role ──────────────────────────────────────
    if (action === 'update_hr_role') {
      const { userId, hr_role, hr_job_title } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const validRoles = ['staff', 'supervisor', 'manager']
      if (!hr_role) return json({ error: NO_RANK_MSG }, 400)
      if (!validRoles.includes(hr_role)) return json({ error: 'Invalid hr_role' }, 400)

      const targetProfile = await loadTarget(userId)
      if (!targetProfile) return json({ error: 'User not found' }, 404)
      if (targetProfile.role === 'admin') return json({ error: 'Forbidden' }, 403)
      if (!isCallerAdmin && targetProfile.client_id !== callerClientId) {
        return json({ error: 'Forbidden' }, 403)
      }
      // Mirror of update_ims_role's first-assignment gate — HR has the same "Existing User" mode
      // (HrStaff.jsx:189), so the same Owner-demotion path exists here.
      if (hr_role && !targetProfile.hr_role && !(isCallerAdmin || isCallerOwner)) {
        return json({ error: 'Only the account owner or an administrator can give an existing login HR access' }, 403)
      }
      if (hr_role && !targetProfile.hr_role && await isLastOwnerLogin(targetProfile)) {
        return json({ error: LAST_OWNER_MSG }, 400)
      }
      if (targetProfile.hr_role) {
        const hrManageDenied = requireManageableTarget(targetProfile, 'hr')
        if (hrManageDenied) return hrManageDenied
      }
      if (hr_role === 'manager' && targetProfile.hr_role !== 'manager' && !(isCallerAdmin || isCallerOwner)) {
        return json({ error: MANAGER_GRANT_MSG }, 403)
      }
      // Same reasoning as update_ims_role's guard — an account already marked POS PIN staff, IMS
      // staff, or HR self-service is RLS-blocked from every hr_ table regardless of hr_role.
      if (hr_role && (targetProfile?.pos_role || targetProfile?.ims_role || targetProfile?.hr_self_service)) {
        return json({ error: 'This account already has POS, IMS, or HR self-service access and cannot also be an HR staff account' }, 400)
      }

      const { error: updateErr } = await admin.from('profiles')
        .update({ hr_role: hr_role || null, hr_job_title: hr_job_title || null })
        .eq('id', userId)
      if (updateErr) return json({ error: updateErr.message }, 400)
      return json({ success: true })
    }

    // ── Delete an HR staff member ──────────────────────────────────────────────
    if (action === 'delete_hr_staff') {
      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const hrTarget = await loadTarget(userId)
      const hrDenied = requireStaffTarget(hrTarget, 'hr')
      if (hrDenied) return hrDenied
      const hrManageDenied = requireManageableTarget(hrTarget!, 'hr')
      if (hrManageDenied) return hrManageDenied

      const { error: delErr } = await admin.auth.admin.deleteUser(userId)
      if (delErr) return json({ error: delErr.message }, 400)
      return json({ success: true })
    }

    // ── Reset an HR staff member's password ────────────────────────────────────
    if (action === 'reset_hr_password') {
      const { userId, password } = params
      if (!userId || !password) return json({ error: 'userId and password are required' }, 400)
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

      // Same client AND actually an HR staff account — mirror of reset_ims_password's guard.
      const hrPwTarget = await loadTarget(userId)
      const hrPwDenied = requireStaffTarget(hrPwTarget, 'hr')
      if (hrPwDenied) return hrPwDenied
      const hrPwManageDenied = requireManageableTarget(hrPwTarget!, 'hr', { allowSelf: true })
      if (hrPwManageDenied) return hrPwManageDenied

      const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password })
      if (updateErr) return json({ error: updateErr.message }, 400)

      return json({ success: true })
    }

    // ── All remaining actions require admin role ──────────────────────────────
    if (profile?.role !== 'admin') return json({ error: 'Forbidden' }, 403)

    // ── Delete a single fixed asset, admin-only — never exposed to any client
    // login (including Owner-rank), even though hasImsAccess('manager') would
    // normally be enough to post/edit within this module. A posted asset's
    // assets_depreciation_schedule rows are blocked by the immutability trigger
    // (enforce_asset_schedule_immutable) for every authenticated session — only
    // this function's service-role client (auth.uid() IS NULL) can clear them,
    // same mechanism Danger Zone already relies on. assets_repair_expenses.asset_id
    // is ON DELETE SET NULL so it needs no explicit cleanup here.
    if (action === 'deleteAsset') {
      const { clientId, assetId } = params
      if (!clientId || !assetId) return json({ error: 'clientId and assetId are required' }, 400)

      const { error: scheduleErr } = await admin
        .from('assets_depreciation_schedule').delete().eq('client_id', clientId).eq('asset_id', assetId)
      if (scheduleErr) return json({ error: `Failed to delete depreciation history: ${scheduleErr.message}` }, 400)

      const { error: assetErr } = await admin
        .from('assets_register').delete().eq('client_id', clientId).eq('id', assetId)
      if (assetErr) return json({ error: `Failed to delete asset: ${assetErr.message}` }, 400)

      return json({ success: true })
    }

    if (action === 'getUser') {
      const result = await admin.auth.admin.getUserById(params.userId)
      return json(result)
    }

    if (action === 'createUser') {
      const result = await admin.auth.admin.createUser({
        email: params.email,
        password: params.password,
        email_confirm: true,
        user_metadata: { full_name: params.full_name ?? '' },
      })
      return json(result)
    }

    if (action === 'deleteUser') {
      const result = await admin.auth.admin.deleteUser(params.userId)
      return json(result)
    }

    // ── Clear one module's transactions, keeping setup/master data ────────────
    // ims: keeps items/vendors/categories/recipes/par levels/periods (periods are shared with HR)
    // hr:  keeps employees/salary components/leave types/holiday calendar/shift types
    // pos: keeps tables/floor plan/staff accounts; frees occupied tables
    if (action === 'clearModuleData') {
      const { clientId, module } = params
      if (!clientId) return json({ error: 'clientId is required' }, 400)
      if (!['ims', 'hr', 'pos'].includes(module)) return json({ error: "module must be 'ims', 'hr' or 'pos'" }, 400)

      async function del(query: Promise<{ error: unknown }>, label: string) {
        const { error } = await query
        if (error) throw new Error(`Failed to delete ${label}: ${(error as { message?: string }).message ?? String(error)}`)
      }

      if (module === 'ims') {
        const periodIds = await readAllIds('monthly_periods', (f, t) =>
          admin.from('monthly_periods').select('id').eq('client_id', clientId).order('id').range(f, t))

        // By client_id (S792, DATABASE-5), not a URL holding every bill line's id.
        await del(admin.from('payable_payments').delete().eq('client_id', clientId), 'payable_payments')
        if (periodIds.length > 0) {
          await del(admin.from('purchase_entries').delete().in('period_id', periodIds), 'purchase_entries')
          await del(admin.from('vendor_returns').delete().in('period_id', periodIds), 'vendor_returns')
          await del(admin.from('opening_stock').delete().in('period_id', periodIds), 'opening_stock')
          await del(admin.from('closing_stock').delete().in('period_id', periodIds), 'closing_stock')
          await del(admin.from('wastages').delete().in('period_id', periodIds), 'wastages')
          await del(admin.from('staff_meals').delete().in('period_id', periodIds), 'staff_meals')
          // Hand-entered sales only, a NULL source among them (S809 DATABASE-2). The till's rows stay
          // with the bills that wrote them: Post POS bills to Inventory skips a stamped bill, so a
          // till row deleted here never came back.
          await del(admin.from('sales_entries').delete().in('period_id', periodIds)
            .or(`source.is.null,source.in.(${IMS_SALES_SOURCES.join(',')})`), 'sales_entries')
          await del(admin.from('budgets').delete().in('period_id', periodIds), 'budgets')
        }

        // The manual Sales Entry depletion only; the till's movements stay with its bills (DATABASE-2).
        await del(admin.from('stock_movements').delete().eq('client_id', clientId).in('source', IMS_MOVEMENT_SOURCES), 'stock_movements')

        const poIds = await readAllIds('purchase_orders', (f, t) =>
          admin.from('purchase_orders').select('id').eq('client_id', clientId).order('id').range(f, t))
        await deleteByIdChunks(admin, 'purchase_order_items', 'po_id', poIds, 'purchase_order_items')
        await del(admin.from('purchase_orders').delete().eq('client_id', clientId), 'purchase_orders')

        const reqIds = await readAllIds('requisitions', (f, t) =>
          admin.from('requisitions').select('id').eq('client_id', clientId).order('id').range(f, t))
        await deleteByIdChunks(admin, 'requisition_lines', 'requisition_id', reqIds, 'requisition_lines')
        await del(admin.from('requisitions').delete().eq('client_id', clientId), 'requisitions')

        await del(admin.from('overheads').delete().eq('client_id', clientId), 'overheads')
        await del(admin.from('demand_forecast_daily').delete().eq('client_id', clientId), 'demand_forecast_daily')
        await del(admin.from('demand_forecast_run_log').delete().eq('client_id', clientId), 'demand_forecast_run_log')
        await del(admin.from('ims_gate_passes').delete().eq('client_id', clientId), 'ims_gate_passes')
        // Fixed Assets — schedule/pool-lines before their parent runs (no cascade on asset_id/
        // category_id, so register/categories must go last too, in that order).
        await del(admin.from('assets_depreciation_schedule').delete().eq('client_id', clientId), 'assets_depreciation_schedule')
        await del(admin.from('assets_depreciation_runs').delete().eq('client_id', clientId), 'assets_depreciation_runs')
        await del(admin.from('assets_tax_pool_lines').delete().eq('client_id', clientId), 'assets_tax_pool_lines')
        await del(admin.from('assets_tax_pool_runs').delete().eq('client_id', clientId), 'assets_tax_pool_runs')
        // D40: the typed pool openings (A–D). After the runs, though the service role passes its lock anyway.
        await del(admin.from('assets_tax_pool_openings').delete().eq('client_id', clientId), 'assets_tax_pool_openings')
        await del(admin.from('assets_repair_expenses').delete().eq('client_id', clientId), 'assets_repair_expenses')
        await del(admin.from('assets_register').delete().eq('client_id', clientId), 'assets_register')
        await del(admin.from('assets_categories').delete().eq('client_id', clientId), 'assets_categories')
        // monthly_periods are intentionally KEPT — HR attendance/payroll reference the same periods
        return json({ success: true })
      }

      if (module === 'hr') {
        const { data: runRows } = await admin.from('hr_payroll_runs').select('id').eq('client_id', clientId)
        const runIds = (runRows || []).map((r: { id: string }) => r.id)
        if (runIds.length > 0) {
          await del(admin.from('hr_payslips').delete().in('run_id', runIds), 'hr_payslips')
        }
        // Repayments and salary payments before the runs they point at (both NO ACTION) — S752, S782.
        await del(admin.from('hr_salary_payments').delete().eq('client_id', clientId), 'hr_salary_payments')
        await del(admin.from('hr_advance_repayments').delete().eq('client_id', clientId), 'hr_advance_repayments')
        await del(admin.from('hr_payroll_runs').delete().eq('client_id', clientId), 'hr_payroll_runs')
        // Before hr_advance_repayments (whose final_settlement_id points at it) and before
        // hr_employees, so neither is left referencing a row that no longer exists.
        await del(admin.from('hr_final_settlements').delete().eq('client_id', clientId), 'hr_final_settlements')
        await del(admin.from('hr_attendance').delete().eq('client_id', clientId), 'hr_attendance')
        await del(admin.from('hr_leave_requests').delete().eq('client_id', clientId), 'hr_leave_requests')
        await del(admin.from('hr_overtime_entries').delete().eq('client_id', clientId), 'hr_overtime_entries')
        await del(admin.from('hr_festival_allowances').delete().eq('client_id', clientId), 'hr_festival_allowances')
        await del(admin.from('hr_advance_repayments').delete().eq('client_id', clientId), 'hr_advance_repayments')
        await del(admin.from('hr_advances').delete().eq('client_id', clientId), 'hr_advances')
        await del(admin.from('hr_roster').delete().eq('client_id', clientId), 'hr_roster')
        // hr_tada_claim_items cascades from hr_tada_claims; hr_incentives.config_id SET NULLs on config delete
        await del(admin.from('hr_tada_claims').delete().eq('client_id', clientId), 'hr_tada_claims')
        await del(admin.from('hr_incentives').delete().eq('client_id', clientId), 'hr_incentives')
        await del(admin.from('hr_incentive_configs').delete().eq('client_id', clientId), 'hr_incentive_configs')
        await del(admin.from('hr_roster_publish_state').delete().eq('client_id', clientId), 'hr_roster_publish_state')
        await del(admin.from('hr_shift_swap_requests').delete().eq('client_id', clientId), 'hr_shift_swap_requests')
        return json({ success: true })
      }

      if (module === 'pos') {
        // Circular FK: pos_orders.credit_note_id -> pos_credit_notes.id AND
        // pos_credit_notes.order_id -> pos_orders.id, neither ON DELETE CASCADE.
        // Null the order-side link first or deleting pos_credit_notes fails.
        await del(admin.from('pos_orders').update({ credit_note_id: null }).eq('client_id', clientId), 'pos_orders.credit_note_id reset')
        await del(admin.from('pos_credit_notes').delete().eq('client_id', clientId), 'pos_credit_notes')
        await del(admin.from('pos_payment_confirmations').delete().eq('client_id', clientId), 'pos_payment_confirmations')
        await del(admin.from('pos_guest_order_requests').delete().eq('client_id', clientId), 'pos_guest_order_requests')
        // By client_id (S792, DATABASE-5), not a URL holding every order id of the till.
        await del(admin.from('pos_order_items').delete().eq('client_id', clientId), 'pos_order_items')
        // The till's Inventory rows go with the orders, and only those (S809 DATABASE-2): this deleted
        // every stock movement of the client, so the manual Sales Entry depletion went with the bills
        // and Book Stock read the shelf as fuller than it was. A credit note's "not served" restock
        // rows (S809 2e) are the till's too, and were in neither clear's list.
        await del(admin.from('stock_movements').delete().eq('client_id', clientId).in('source', POS_MOVEMENT_SOURCES), 'pos stock_movements')
        const { data: periods, error: periodsErr } = await admin.from('monthly_periods').select('id').eq('client_id', clientId)
        if (periodsErr) throw new Error(`Failed to read monthly_periods: ${periodsErr.message}`)
        const periodIds = (periods || []).map((p: { id: string }) => p.id)
        if (periodIds.length > 0) {
          await del(admin.from('sales_entries').delete().in('period_id', periodIds).in('source', POS_SALES_SOURCES), 'pos sales_entries')
        }
        // Before orders/shifts: its FKs to both are ON DELETE SET NULL, so leaving it until
        // after would orphan the rows rather than remove them.
        await del(admin.from('pos_cash_movements').delete().eq('client_id', clientId), 'pos_cash_movements')
        // pos_kot_removals cascades from pos_orders, so this delete is not load-bearing — it is
        // here so the sequence still names every table it clears, which is what makes a missed
        // one visible on review (S382's pos_credit_notes was missed exactly by being implicit).
        await del(admin.from('pos_loyalty_ledger').delete().eq('client_id', clientId), 'pos_loyalty_ledger')
        await del(admin.from('pos_reservation_tables').delete().eq('client_id', clientId), 'pos_reservation_tables')
        await del(admin.from('pos_reservations').delete().eq('client_id', clientId), 'pos_reservations')
        await del(admin.from('pos_kot_removals').delete().eq('client_id', clientId), 'pos_kot_removals')
        await del(admin.from('pos_orders').delete().eq('client_id', clientId), 'pos_orders')
        await del(admin.from('pos_shifts').delete().eq('client_id', clientId), 'pos_shifts')
        await del(admin.from('pos_customers').delete().eq('client_id', clientId), 'pos_customers')
        await del(admin.from('pos_loyalty_schemes').delete().eq('client_id', clientId), 'pos_loyalty_schemes')
        await del(admin.from('pos_parking_slips').delete().eq('client_id', clientId), 'pos_parking_slips')
        // Tables are kept (setup) but any left "occupied" by a deleted order are freed
        await admin.from('pos_tables').update({ status: 'available' }).eq('client_id', clientId)
        return json({ success: true })
      }
    }

    if (action === 'deleteClientData') {
      const { clientId, keep_staff_vault } = params
      if (!clientId) return json({ error: 'clientId is required' }, 400)
      // S755: the caller is recorded as the revoker of every tablet key this clears.
      const tablets = await deleteClientDataFor(admin, clientId, keep_staff_vault === true, user.id)
      return json({ success: true, ...tablets })
    }

    return json({ error: `Unknown action: ${action}` }, 400)
  } catch (err) {
    // Was defaulting to HTTP 200 with an error body, so callers had no way to tell a thrown
    // failure from a success by status alone (and the clearModuleData/deleteClientData sequences
    // throw mid-run by design when an FK blocks them).
    return json({ error: (err as Error).message }, 500)
  }
})
